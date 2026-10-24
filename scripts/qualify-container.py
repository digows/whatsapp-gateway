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
    token = str(uuid.uuid4())
    configuration = {
        "storage": {"engine": "sqlite", "mode": "local", "filename": "/data/gateway.sqlite"},
        "workspaces": [{
            "workspaceId": workspace_id,
            "accounts": [{"accountId": account_id, "enabled": False}],
        }],
        "http": {"enabled": True, "host": "0.0.0.0", "port": 8080},
        "principals": [{
            "id": "container-fixture", "httpToken": token,
            "grants": [{"workspaceId": workspace_id, "accountIds": [account_id]}],
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
const workspace=configuration.workspaces[0];
const account=workspace.accounts[0];
const database=new Database(':memory:');
const sqlite=database.prepare('select sqlite_version() as version').get().version;
database.close();
for(const packageName of ['@mastra/core','chat']) {
  try {await import(packageName);throw new Error('Unexpected framework dependency');}
  catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
}
const scope={workspaceId:workspace.workspaceId,accountId:account.accountId};
const requestId=crypto.randomUUID();
const response=await fetch('http://127.0.0.1:8080/v1/commands',{
  method:'POST',
  headers:{authorization:'Bearer '+configuration.principals[0].httpToken,'content-type':'application/json'},
  body:JSON.stringify({...scope,apiVersion:'1',requestId,type:'presence',chatAddress:'200@s.whatsapp.net',composing:true})
});
if(response.status!==202)throw new Error('Command intake failed');
const receipt=await response.json();
if(receipt.state!=='PENDING')throw new Error('Disabled account executed a command');
const docs=await fetch('http://127.0.0.1:8080/docs/swagger-ui-bundle.js');
if(docs.status!==200)throw new Error('Swagger assets are missing');
console.log(JSON.stringify({node:process.version,architecture:process.arch,platform:process.platform,
  sqlite,uid:process.getuid(),requestId,scope,swaggerBytes:(await docs.arrayBuffer()).byteLength,
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
        restart_ms = wait_for_readiness(application_name)
        command_route = (
            f"http://127.0.0.1:8080/v1/accounts/{workspace_id}/{account_id}"
            f"/commands/{result['requestId']}"
        )
        verify = r"""
import fs from 'node:fs';
const configuration=JSON.parse(fs.readFileSync('/run/secrets/gateway.json','utf8'));
const response=await fetch(COMMAND_ROUTE,{
  headers:{authorization:'Bearer '+configuration.principals[0].httpToken}
});
const receipt=await response.json();
if(response.status!==200||receipt.state!=='PENDING')throw new Error('Durable intake lost on restart');
console.log(receipt.state);
""".replace("COMMAND_ROUTE", json.dumps(command_route))
        require(
            docker("exec", "-i", application_name, "node", "--input-type=module", input_text=verify)
            == "PENDING",
            "Restart did not preserve the pending command",
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
