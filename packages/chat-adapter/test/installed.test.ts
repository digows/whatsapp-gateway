import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RemoteFixture } from "./support/remote-fixture.ts";
const execute = promisify(execFile);
const temporaryRoot = process.env["TMPDIR"];
const store = process.env["GATEWAY_TEST_PNPM_STORE"];
if (!temporaryRoot || !store)
{
  throw new Error("Explicit owned temporary root and populated pnpm store required");
}
const repository = fileURLToPath(new URL("../../../", import.meta.url));
test("packed and freshly installed Adapter runs released native Mastra channels without source exports", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-installed-"));
  const fixture = new RemoteFixture();
  const archivePaths = new Map<string, string>();
  const archiveServer = createServer((request, response) =>
  {
    const archive = archivePaths.get(request.url ?? "");
    if (archive === undefined)
    {
      response.writeHead(404).end();
      return;
    }
    readFile(archive).then(bytes =>
      response.writeHead(200, { "content-type": "application/gzip" }).end(bytes)
    )
      .catch(() => response.writeHead(500).end());
  });
  try
  {
    for (const packageDirectory of ["packages/contracts", "packages/chat-adapter"])
    {
      await execute("pnpm", [
        "--store-dir",
        store,
        "--dir",
        join(repository, packageDirectory),
        "pack",
        "--pack-destination",
        directory,
      ], { cwd: repository, env: process.env, timeout: 30000 });
    }
    const archives = await readdir(directory);
    const contracts = archives.find(name =>
      name.startsWith("digows-whatsapp-gateway-contracts-") && name.endsWith(".tgz")
    );
    const adapter = archives.find(name =>
      name.startsWith("digows-chat-adapter-whatsapp-gateway-") && name.endsWith(".tgz")
    );
    assert.ok(contracts && adapter);
    archivePaths.set(`/${contracts}`, join(directory, contracts));
    archivePaths.set(`/${adapter}`, join(directory, adapter));
    await new Promise<void>((resolve, reject) =>
    {
      archiveServer.once("error", reject);
      archiveServer.listen(0, "127.0.0.1", resolve);
    });
    const address = archiveServer.address();
    assert.ok(address && typeof address !== "string");
    const archiveOrigin = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "gateway-installed-consumer",
        private: true,
        type: "module",
        packageManager: "pnpm@12.9.1",
        dependencies: {
          "@digows/whatsapp-gateway-contracts": `${archiveOrigin}/${contracts}`,
          "@digows/chat-adapter-whatsapp-gateway": `${archiveOrigin}/${adapter}`,
          chat: "4.43.0",
          "@mastra/core": "1.79.0",
          "@chat-adapter/state-memory": "4.43.0",
        },
      }),
    );
    await writeFile(
      join(directory, "pnpm-workspace.yaml"),
      JSON.stringify({
        blockExoticSubdeps: true,
      }),
    );
    await execute("pnpm", ["--store-dir", store, "install", "--prefer-offline"], {
      cwd: directory,
      env: process.env,
      timeout: 60000,
    });
    await fixture.start("sqlite", "http");
    const event = await fixture.inbound();
    const configuration = {
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountId,
      url: fixture.http.origin,
      token: fixture.token,
      secret: fixture.secret,
      event,
    };
    const filename = join(directory, "fixture.json");
    await writeFile(filename, JSON.stringify(configuration), { mode: 0o600 });
    const program = `
import {WhatsAppGatewayAdapter,GatewayRemoteClient,GatewayHttpClient} from '@digows/chat-adapter-whatsapp-gateway';
import {createMastraGatewayExample} from '@digows/chat-adapter-whatsapp-gateway/examples/mastra';
import {signGatewayWebhook,outboundMessageDigest} from '@digows/whatsapp-gateway-contracts';
import {createMemoryState} from '@chat-adapter/state-memory';
import {InMemoryStore} from '@mastra/core/storage';
import {createMockModel} from '@mastra/core/test-utils/llm-mock';
import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.argv[2]));
const scope={workspaceId:c.workspaceId,accountId:c.accountId};
const client=new GatewayRemoteClient(scope,new GatewayHttpClient({url:c.url,token:c.token,pollIntervalMs:5}));
const adapter=new WhatsAppGatewayAdapter({...scope,client,nativeJid:'100@s.whatsapp.net',webhookSecret:c.secret});
let modelCalls=0;
const model=createMockModel({version:'v2',mockText:'Reply from installed native Mastra',spyStream:()=>{modelCalls++;}});
const composition=await createMastraGatewayExample({adapter,model,state:createMemoryState(),storage:new InMemoryStore()});
try {
  const body=Buffer.from(JSON.stringify(c.event));
  const signed=await signGatewayWebhook(c.secret,c.event.id,String(Math.floor(Date.now()/1000)),body);
  const request=()=>new Request('http://consumer.invalid/webhook',{method:'POST',headers:{'x-gateway-event-id':signed.eventId,'x-gateway-timestamp':signed.timestamp,'x-gateway-signature':signed.signature},body});
  if((await adapter.handleWebhook(request())).status!==204)throw new Error('Installed native intake failed');
  const thread=adapter.encodeThreadId({...scope,chatId:'200@s.whatsapp.net'});
  const history=await adapter.fetchMessages(thread);
  if(!modelCalls||!history.messages.some(message=>message.author.isMe&&message.text.includes('Reply from installed native Mastra')))throw new Error('Installed framework reply missing');
  if((await adapter.handleWebhook(request())).status!==204||modelCalls!==1)throw new Error('Completed event replay was not deduplicated');
  const first=await adapter.postWithKey(thread,'Stable installed send','installed-stable-key');
  const second=await adapter.postWithKey(thread,'Stable installed send','installed-stable-key');
  if(first.id!==second.id)throw new Error('Installed operation identity changed');
  const operation=await client.operation(c.accountId,'installed-stable-key');
  const digest=await outboundMessageDigest({channel:'WHATSAPP',senderAddress:'100@s.whatsapp.net',recipientAddress:'200@s.whatsapp.net',contentKind:'TEXT',text:'Stable installed send',idempotencyKey:'installed-stable-key'});
  if(operation.digest!==digest)throw new Error('Installed operation payload binding differs');
  let conflict=false;try{await adapter.postWithKey(thread,'Conflicting content','installed-stable-key');}catch{conflict=true;}
  if(!conflict)throw new Error('Installed payload conflict was accepted');
  if(JSON.stringify(await client.operation(c.accountId,'installed-stable-key'))!==JSON.stringify(operation))throw new Error('Conflict replaced original operation');
  console.log('CONSUMER_RESULT '+JSON.stringify({stableId:first.id,modelCalls,adapterUrl:import.meta.resolve('@digows/chat-adapter-whatsapp-gateway'),mastra:JSON.parse(fs.readFileSync('node_modules/@mastra/core/package.json')).version,chat:JSON.parse(fs.readFileSync('node_modules/chat/package.json')).version}));
} finally {await composition.mastra.shutdown();}
`;
    const entry = join(directory, "consumer.mjs");
    await writeFile(entry, program);
    const result = await execute(process.execPath, [entry, filename], {
      cwd: directory,
      env: process.env,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const line = result.stdout.split("\n").find(value => value.startsWith("CONSUMER_RESULT "));
    assert.ok(line);
    const observation: unknown = JSON.parse(line.slice(16));
    assert.ok(
      typeof observation === "object" && observation !== null && "stableId" in observation
        && typeof observation.stableId === "string",
    );
    assert.equal(
      fixture.socket.sent.filter(sent => sent.options["messageId"] === observation.stableId).length,
      1,
    );
    assert.ok(
      "adapterUrl" in observation && typeof observation.adapterUrl === "string"
        && observation.adapterUrl.includes("/dist/src/index.js"),
    );
    assert.ok("mastra" in observation && observation.mastra === "1.79.0");
    assert.ok("chat" in observation && observation.chat === "4.43.0");
  }
  finally
  {
    await fixture.close();
    if (archiveServer.listening)
    {
      await new Promise<void>((resolve, reject) =>
        archiveServer.close(error => error ? reject(error) : resolve())
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});
