<#
Second-user named-pipe prober for windows-pipe-security.test.ts (Windows
PowerShell 5.1). Logs on as another local user, impersonates it on one thread,
and tries to open or create instances of a pipe as that user.

Inputs come only from the environment, never the command line:
  CANOPY_PIPE_PROBE_USER, CANOPY_PIPE_PROBE_PASSWORD  second user ("name" or "DOMAIN\name")
  CANOPY_PIPE_PROBE_PATH                              \\.\pipe\... name
  CANOPY_PIPE_PROBE_MODE                              once | loop
  CANOPY_PIPE_PROBE_DURATION_MS                       loop only
  CANOPY_PIPE_PROBE_READY_FILE                        loop only; written once impersonated and looping

Prints one JSON line. Error codes are Win32 codes; 0 means the attempt
succeeded (its handle is closed at once). Exit 0 whenever the probe ran, even
if access was granted: the test asserts. Exit 2 on setup failure with
{"error":"<stage>","code":N}. Never prints credentials, SIDs, or names.
#>

param([string]$OwnershipPath = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

try {
  if ($OwnershipPath) {
    $self = Get-Process -Id $PID
    $journal = @{ fixture = $env:CANOPY_PIPE_FIXTURE_ID; pid = $PID; startedTicks = $self.StartTime.ToUniversalTime().Ticks.ToString() }
    [IO.File]::WriteAllText("$OwnershipPath.new", ($journal | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move("$OwnershipPath.new", $OwnershipPath)
  }
} catch {
  [Console]::Out.WriteLine('{"error":"ownership-journal","code":-1}')
  exit 2
}

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class CanopyPipeProbe
{
    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
    const uint READ_CONTROL = 0x00020000;
    const uint FILE_SHARE_READ_WRITE = 0x00000003;
    const uint OPEN_EXISTING = 3;
    const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    const uint PIPE_TYPE_BYTE_WAIT = 0x00000000;
    const int LOGON32_LOGON_INTERACTIVE = 2;
    const int LOGON32_LOGON_NETWORK = 3;
    const int LOGON32_PROVIDER_DEFAULT = 0;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LogonUserW(string user, string domain, string password,
        int logonType, int provider, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool ImpersonateLoggedOnUser(IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool RevertToSelf();

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateNamedPipeW(string name, uint openMode,
        uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer,
        uint defaultTimeout, IntPtr security);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    sealed class SetupFailure : Exception
    {
        public readonly string Stage;
        public readonly int Code;
        public SetupFailure(string stage, int code)
        {
            Stage = stage;
            Code = code;
        }
    }

    static string Error(string stage, int code)
    {
        return "{\"error\":\"" + stage + "\",\"code\":" + code + "}";
    }

    static int Result(IntPtr handle)
    {
        if (handle == INVALID_HANDLE_VALUE || handle == IntPtr.Zero)
            return Marshal.GetLastWin32Error();
        CloseHandle(handle);
        return 0;
    }

    static int Open(string path, uint access)
    {
        return Result(CreateFileW(path, access, FILE_SHARE_READ_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero));
    }

    static int CreateInstance(string path, uint extraFlags)
    {
        return Result(CreateNamedPipeW(path, PIPE_ACCESS_DUPLEX | extraFlags,
            PIPE_TYPE_BYTE_WAIT, 1, 4096, 4096, 0, IntPtr.Zero));
    }

    // True only when the thread token is a different user than the process.
    static bool Impersonating(SecurityIdentifier processUser)
    {
        try
        {
            using (WindowsIdentity thread = WindowsIdentity.GetCurrent(true))
            {
                return thread != null && thread.User != null &&
                    !thread.User.Equals(processUser);
            }
        }
        catch (Exception)
        {
            return false;
        }
    }

    static string Once(string path, int logonType, bool impersonated)
    {
        string[] names = { "rw", "read", "attributes", "readControl",
            "createInstance", "firstInstance" };
        int[] codes = {
            Open(path, GENERIC_READ | GENERIC_WRITE),
            Open(path, GENERIC_READ),
            Open(path, FILE_READ_ATTRIBUTES),
            Open(path, READ_CONTROL),
            CreateInstance(path, 0),
            CreateInstance(path, FILE_FLAG_FIRST_PIPE_INSTANCE),
        };
        StringBuilder json = new StringBuilder();
        json.Append("{\"logonType\":").Append(logonType)
            .Append(",\"impersonated\":").Append(impersonated ? "true" : "false")
            .Append(",\"results\":{");
        for (int i = 0; i < names.Length; i++)
        {
            if (i > 0) json.Append(',');
            json.Append('"').Append(names[i]).Append("\":").Append(codes[i]);
        }
        return json.Append("}}").ToString();
    }

    static string Loop(string path, int logonType, bool impersonated,
        int durationMs, string readyFile, IntPtr token,
        SecurityIdentifier processUser)
    {
        uint[] accesses = { GENERIC_READ | GENERIC_WRITE, GENERIC_READ };
        SortedDictionary<int, int> codes = new SortedDictionary<int, int>();
        long attempts = 0;
        long successes = 0;
        bool ready = false;
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < durationMs)
        {
            foreach (uint access in accesses)
            {
                int code = Open(path, access);
                attempts++;
                if (code == 0)
                {
                    successes++;
                    continue;
                }
                int seen;
                codes.TryGetValue(code, out seen);
                codes[code] = seen + 1;
            }
            if (ready) continue;
            ready = true;
            // The ready file lives where only the test user can write.
            RevertToSelf();
            File.WriteAllText(readyFile, "ready");
            if (!ImpersonateLoggedOnUser(token))
                throw new SetupFailure("impersonate",
                    Marshal.GetLastWin32Error());
            impersonated = impersonated && Impersonating(processUser);
        }
        StringBuilder json = new StringBuilder();
        json.Append("{\"logonType\":").Append(logonType)
            .Append(",\"impersonated\":").Append(impersonated ? "true" : "false")
            .Append(",\"attempts\":").Append(attempts)
            .Append(",\"successes\":").Append(successes)
            .Append(",\"codes\":{");
        bool first = true;
        foreach (KeyValuePair<int, int> entry in codes)
        {
            if (!first) json.Append(',');
            first = false;
            json.Append('"').Append(entry.Key).Append("\":").Append(entry.Value);
        }
        return json.Append("}}").ToString();
    }

    // One method on one thread: impersonation is per-thread.
    public static int Run(out string json)
    {
        string user = Environment.GetEnvironmentVariable("CANOPY_PIPE_PROBE_USER");
        string password = Environment.GetEnvironmentVariable("CANOPY_PIPE_PROBE_PASSWORD");
        string path = Environment.GetEnvironmentVariable("CANOPY_PIPE_PROBE_PATH");
        string mode = Environment.GetEnvironmentVariable("CANOPY_PIPE_PROBE_MODE");
        string readyFile = Environment.GetEnvironmentVariable("CANOPY_PIPE_PROBE_READY_FILE");
        int durationMs = 0;
        if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(password) ||
            string.IsNullOrEmpty(path) || (mode != "once" && mode != "loop") ||
            (mode == "loop" && (string.IsNullOrEmpty(readyFile) ||
                !int.TryParse(Environment.GetEnvironmentVariable(
                    "CANOPY_PIPE_PROBE_DURATION_MS"), out durationMs) ||
                durationMs <= 0)))
        {
            json = Error("input", 0);
            return 2;
        }
        string domain = ".";
        string name = user;
        int slash = user.IndexOf('\\');
        if (slash >= 0)
        {
            domain = user.Substring(0, slash);
            name = user.Substring(slash + 1);
        }

        SecurityIdentifier processUser;
        using (WindowsIdentity self = WindowsIdentity.GetCurrent())
        {
            processUser = self.User;
        }
        IntPtr token;
        int logonType = LOGON32_LOGON_INTERACTIVE;
        if (!LogonUserW(name, domain, password, logonType,
                LOGON32_PROVIDER_DEFAULT, out token))
        {
            int interactiveError = Marshal.GetLastWin32Error();
            logonType = LOGON32_LOGON_NETWORK;
            if (!LogonUserW(name, domain, password, logonType,
                    LOGON32_PROVIDER_DEFAULT, out token))
            {
                int networkError = Marshal.GetLastWin32Error();
                json = "{\"error\":\"logon\",\"code\":" + networkError +
                    ",\"interactive\":" + interactiveError +
                    ",\"network\":" + networkError + "}";
                return 2;
            }
        }
        bool impersonating = false;
        try
        {
            if (!ImpersonateLoggedOnUser(token))
            {
                json = Error("impersonate", Marshal.GetLastWin32Error());
                return 2;
            }
            impersonating = true;
            bool impersonated = Impersonating(processUser);
            json = mode == "once"
                ? Once(path, logonType, impersonated)
                : Loop(path, logonType, impersonated, durationMs, readyFile,
                    token, processUser);
            return 0;
        }
        catch (SetupFailure failure)
        {
            json = Error(failure.Stage, failure.Code);
            return 2;
        }
        finally
        {
            if (impersonating) RevertToSelf();
            CloseHandle(token);
        }
    }
}
'@

$stage = 'compile'
try {
  Add-Type -TypeDefinition $source -Language CSharp
  $stage = 'execute'
  $json = $null
  $code = [CanopyPipeProbe]::Run([ref]$json)
} catch {
  # The message could echo inputs; report the stage only.
  [Console]::Out.WriteLine(('{"error":"' + $stage + '","code":' + $_.Exception.HResult + '}'))
  exit 2
}
[Console]::Out.WriteLine($json)
exit $code
