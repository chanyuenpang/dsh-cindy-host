import { spawn } from 'node:child_process';

export class CredentialStoreUnavailableError extends Error {
  constructor(message = '本机凭据存储不可用。Linux 请检查 secret-tool 和已解锁的 Secret Service；macOS 请检查钥匙串授权；Windows 请检查系统 PowerShell 和 DSH 原生凭据服务。') {
    super(message);
    this.name = 'CredentialStoreUnavailableError';
    this.code = 'CREDENTIAL_STORE_UNAVAILABLE';
  }
}

/** No shell, no secret argv, bounded time/output, and never expose child diagnostics. */
export function runCredentialCommand(file, args, input = '', { timeoutMs = 15_000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new CredentialStoreUnavailableError()); return; }
    let done = false;
    let bytes = 0;
    const stdout = [];
    const stderr = [];
    const fail = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      reject(new CredentialStoreUnavailableError());
    };
    const timer = setTimeout(fail, timeoutMs);
    child.on('error', fail);
    child.stdin.on('error', fail);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('error', fail);
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { fail(); return; }
        chunks.push(chunk);
      });
    }
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

// System .NET assembly, not C# compilation. All data (including entropy) travels on stdin.
export const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$r = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$data = [Convert]::FromBase64String($r.data)',
  '$entropy = [Convert]::FromBase64String($r.entropy)',
  "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if ($r.operation -eq 'protect') { $result = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) } elseif ($r.operation -eq 'unprotect') { $result = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) } else { throw 'Invalid operation' }",
  '[Console]::Out.Write([Convert]::ToBase64String($result))',
].join('; ');
