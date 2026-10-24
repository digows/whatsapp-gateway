"""Exercise an existing image without external networking or real WhatsApp accounts."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*arguments, input_text=None):
    return subprocess.check_output(
        ["docker", *arguments], input=input_text, text=True
    ).strip()


def wait_for_readiness(container):
    started = time.monotonic()
    docker("start", container)
    while time.monotonic() - started < 15:
        probe = subprocess.run(
            [
                "docker", "exec", container, "node", "--input-type=module", "-e",
                "const response=await fetch('http://127.0.0.1:8080/health/ready');"
                "if(response.status!==200)process.exit(1);",
            ],
            capture_output=True,
            text=True,
        )
        if probe.returncode == 0:
            return round((time.monotonic() - started) * 1000, 3)
        time.sleep(0.1)
    raise RuntimeError("Container did not become ready within the qualification deadline")


def main():
    require(
        len(sys.argv) == 2 and os.environ.get("TMPDIR"),
        "Usage: TMPDIR=<owned directory> python3 scripts/qualify-container.py <image>",
    )
    image = sys.argv[1]
    directory = Path(tempfile.mkdtemp(prefix="gateway-container-", dir=os.environ["TMPDIR"]))
    qualification_id = str(uuid.uuid4())
    label_name = "com.digows.whatsapp-gateway.qualification"
    label = label_name + "=" + qualification_id
    volume = "gateway-qualification-" + qualification_id
    migration_name = volume + "-migrate"
    application_name = volume + "-app"
    containers = []
    created_volume = None
    workspace_id = str(uuid.uuid4())
    account_id = str(uuid.uuid4())
    second_account_id = str(uuid.uuid4())
    other_workspace_id = str(uuid.uuid4())
    token = str(uuid.uuid4())
    configuration = {
        "storage": {"engine": "sqlite", "mode": "local", "directory": "/data/workspaces"},
        "workspaces": [
            {"workspaceId": workspace_id, "accounts": [
                {"accountId": account_id, "enabled": False},
                {"accountId": second_account_id, "enabled": False},
            ]},
            {"workspaceId": other_workspace_id, "accounts": [{"accountId": account_id, "enabled": False}]},
        ],
        "http": {"enabled": True, "host": "0.0.0.0", "port": 8080},
        "principals": [{
            "id": "container-fixture", "httpToken": token,
            "grants": [{"workspaceId": selected, "accountIds": [account_id, second_account_id]}
                       for selected in [workspace_id, other_workspace_id]],
        }],
        "logging": {"level": "debug", "components": {"baileys": "trace"}},
    }
    filename = directory / "operator.json"
    filename.write_text(json.dumps(configuration))
    # Synthetic fixture credentials only; the image runs under the node UID.
    filename.chmod(0o644)
    try:
        created_volume = docker("volume", "create", "--label", label, volume)
        migration_id = docker(
            "create", "--name", migration_name, "--label", label, "--network", "none",
            "--mount", f"type=volume,source={volume},target=/data", image, "migrate",
        )
        containers.append(migration_id)
        docker("cp", str(filename), migration_name + ":/run/secrets/gateway.json")
        docker("start", "-a", migration_name)
        migration = json.loads(docker("inspect", migration_name))[0]
        require(migration["State"]["ExitCode"] == 0, "Image migration failed")

        application_id = docker(
            "create", "--name", application_name, "--label", label, "--network", "none",
            "--mount", f"type=volume,source={volume},target=/data", image,
        )
        containers.append(application_id)
        docker("cp", str(filename), application_name + ":/run/secrets/gateway.json")
        startup_ms = wait_for_readiness(application_name)
        probe = r"""
import Database from 'better-sqlite3';
import fs from 'node:fs';
const configuration=JSON.parse(fs.readFileSync('/run/secrets/gateway.json','utf8'));
const database=new Database(':memory:');
const sqlite=database.prepare('select sqlite_version() as version').get().version;
database.close();
for(const packageName of ['@mastra/core','chat']) {
  try {await import(packageName);throw new Error('Unexpected framework dependency');}
  catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
}
const requestId=crypto.randomUUID();
const scopes=[];
const headers={authorization:'Bearer '+configuration.principals[0].httpToken,'content-type':'application/json'};
for(const workspace of configuration.workspaces) {
  const scope={workspaceId:workspace.workspaceId,accountId:workspace.accounts[0].accountId};
  scopes.push(scope);
  for(const account of workspace.accounts) {
    const response=await fetch('http://127.0.0.1:8080/v1/accounts/'+workspace.workspaceId+'/'+account.accountId,{headers});
    const value=await response.json();
    if(response.status!==200||value.workspaceId!==workspace.workspaceId||value.accountId!==account.accountId)throw new Error('Account routing failed');
  }
  const response=await fetch('http://127.0.0.1:8080/v1/commands',{
    method:'POST',headers,
    body:JSON.stringify({...scope,apiVersion:'1',requestId,type:'presence',chatAddress:'200@s.whatsapp.net',composing:true})
  });
  const receipt=await response.json();
  if(response.status!==202||receipt.state!=='PENDING'||receipt.workspaceId!==workspace.workspaceId)throw new Error('Scoped durable intake failed');
}
const absent=await fetch('http://127.0.0.1:8080/v1/accounts/'+configuration.workspaces[1].workspaceId+'/'+configuration.workspaces[0].accounts[1].accountId,{headers});
if(absent.status!==404)throw new Error('Account leaked across workspace files');
const docs=await fetch('http://127.0.0.1:8080/docs/swagger-ui-bundle.js');
if(docs.status!==200)throw new Error('Swagger assets are missing');
console.log(JSON.stringify({node:process.version,architecture:process.arch,platform:process.platform,
  sqlite,uid:process.getuid(),requestId,scope:scopes[0],scopes,swaggerBytes:(await docs.arrayBuffer()).byteLength,
  frameworkDependencies:false}));
"""
        result = json.loads(docker(
            "exec", "-i", application_name, "node", "--input-type=module", input_text=probe
        ))
        stopped_at = time.monotonic()
        docker("stop", "--time", "20", application_name)
        shutdown_ms = round((time.monotonic() - stopped_at) * 1000, 3)
        application = json.loads(docker("inspect", application_name))[0]
        require(application["State"]["ExitCode"] == 0, "Image shutdown failed")
        logs = docker("logs", application_name)
        require("runtime_stopped" in logs, "Graceful shutdown was not observed")
        require("socket_starting" not in logs, "A disabled fixture account started a socket")
        require(token not in logs, "Credential appeared in image logs")
        inspection_name = volume + "-inspect"
        inspection_program = r"""
import Database from 'better-sqlite3';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const configuration=JSON.parse(fs.readFileSync('/run/secrets/gateway.json','utf8'));
const verified=execFileSync(process.execPath,['dist/cli.js','verify-storage'],{encoding:'utf8'});
if(!verified.includes('storage_verification_completed'))throw new Error('Compiled CLI verification failed');
const filenames=fs.readdirSync(configuration.storage.directory).filter(name=>name.endsWith('.sqlite')).sort();
const expected=configuration.workspaces.map(workspace=>workspace.workspaceId+'.sqlite').sort();
if(JSON.stringify(filenames)!==JSON.stringify(expected))throw new Error('Workspace file layout mismatch');
const counts=[];
for(const workspace of configuration.workspaces) {
  const filename=configuration.storage.directory+'/'+workspace.workspaceId+'.sqlite';
  if((fs.statSync(filename).mode&0o077)!==0)throw new Error('Workspace file is not private');
  const database=new Database(filename,{readonly:true});
  try {
    const binding=database.prepare('SELECT workspace_id FROM workspace_binding WHERE singleton=1').get();
    const accounts=database.prepare('SELECT count(*) AS count FROM account').get().count;
    const foreign=database.prepare('SELECT count(*) AS count FROM account WHERE workspace_id<>?').get(workspace.workspaceId).count;
    if(binding?.workspace_id!==workspace.workspaceId||accounts!==workspace.accounts.length||foreign!==0)throw new Error('Workspace data isolation failed');
    counts.push(accounts);
  } finally {database.close();}
}
console.log(JSON.stringify({filenames,accountCounts:counts,cliVerified:true,foreignWorkspaceRows:0}));
"""
        inspection_id = docker(
            "create", "--name", inspection_name, "--label", label, "--network", "none",
            "--mount", f"type=volume,source={volume},target=/data", "--entrypoint", "node",
            image, "--input-type=module", "-e", inspection_program,
        )
        containers.append(inspection_id)
        docker("cp", str(filename), inspection_name + ":/run/secrets/gateway.json")
        inspection_output = docker("start", "-a", inspection_name)
        inspection = json.loads(docker("inspect", inspection_name))[0]
        require(inspection["State"]["ExitCode"] == 0, "Workspace file qualification failed")
        result["workspaceStorage"] = json.loads(inspection_output)
        restart_ms = wait_for_readiness(application_name)
        command_routes = [
            f"http://127.0.0.1:8080/v1/accounts/{scope['workspaceId']}/{scope['accountId']}"
            f"/commands/{result['requestId']}" for scope in result["scopes"]
        ]
        verify = r"""
import fs from 'node:fs';
const configuration=JSON.parse(fs.readFileSync('/run/secrets/gateway.json','utf8'));
for(const route of COMMAND_ROUTES) {
  const response=await fetch(route,{
    headers:{authorization:'Bearer '+configuration.principals[0].httpToken}
  });
  const receipt=await response.json();
  if(response.status!==200||receipt.state!=='PENDING')throw new Error('Durable intake lost on restart');
}
console.log('PENDING');
""".replace("COMMAND_ROUTES", json.dumps(command_routes))
        require(
            docker("exec", "-i", application_name, "node", "--input-type=module", input_text=verify)
            == "PENDING",
            "Restart did not preserve both workspaces' pending commands",
        )
        docker("stop", "--time", "20", application_name)
        restarted = json.loads(docker("inspect", application_name))[0]
        require(restarted["State"]["ExitCode"] == 0, "Restarted image shutdown failed")
        result.update({
            "imageId": application["Image"], "startupMs": startup_ms,
            "shutdownMs": shutdown_ms, "restartMs": restart_ms,
            "exitCode": application["State"]["ExitCode"],
            "networkMode": application["HostConfig"]["NetworkMode"],
            "liveWhatsApp": False, "publicationPerformed": False,
        })
        print(json.dumps(result, indent=2))
    finally:
        for identifier in reversed(containers):
            observed = json.loads(docker("inspect", identifier))[0]
            require(
                observed["Config"]["Labels"].get(label_name) == qualification_id,
                "Refusing to remove a container outside this qualification",
            )
            docker("rm", "-f", "-v", identifier)
        if created_volume:
            observed = json.loads(docker("volume", "inspect", created_volume))[0]
            require(
                observed["Labels"].get(label_name) == qualification_id,
                "Refusing to remove a volume outside this qualification",
            )
            docker("volume", "rm", created_volume)
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
