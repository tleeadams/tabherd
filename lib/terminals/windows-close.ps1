param([int]$TargetPid)

# Ends a session and closes its terminal tab. It ends the session's process,
# and the ones it started, then, if it ran in a shell, as it does in a
# terminal tab, types `exit` into that shell. The shell exits as if you'd
# typed it, so Windows Terminal closes the tab instead of leaving a "process
# exited" message. A shell that won't take the typing is ended instead.
# Prints one line of JSON.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices;

// An INPUT_RECORD holding a KEY_EVENT_RECORD, flattened.
[StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
public struct KeyRecord {
  [FieldOffset(0)] public ushort EventType;
  [FieldOffset(4)] public int KeyDown;
  [FieldOffset(8)] public ushort RepeatCount;
  [FieldOffset(10)] public ushort VirtualKeyCode;
  [FieldOffset(12)] public ushort VirtualScanCode;
  [FieldOffset(14)] public char UnicodeChar;
  [FieldOffset(16)] public uint ControlKeyState;
}

public static class C {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", EntryPoint = "WriteConsoleInputW")] public static extern bool WriteConsoleInput(IntPtr input, KeyRecord[] records, uint count, out uint written);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);

  // The input buffer of whichever console this process is attached to.
  public static IntPtr OpenConsoleInput() {
    return CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
  }

  // Key-down and key-up records for each character, as if typed.
  public static bool Type(IntPtr input, string text) {
    var records = new List<KeyRecord>();
    foreach (char c in text) {
      short scan = VkKeyScan(c);
      ushort vk = (ushort)(scan == -1 ? 0 : scan & 0xff);
      uint shift = scan != -1 && (scan & 0x100) != 0 ? 0x10u : 0u;
      for (int down = 1; down >= 0; down--) {
        records.Add(new KeyRecord { EventType = 1, KeyDown = down, RepeatCount = 1, VirtualKeyCode = vk,
          VirtualScanCode = (ushort)MapVirtualKey(vk, 0), UnicodeChar = c, ControlKeyState = shift });
      }
    }
    uint written;
    return WriteConsoleInput(input, records.ToArray(), (uint)records.Count, out written) && written == records.Count;
  }
}
"@

function Out-Result($ok, $props) {
  $props.ok = $ok
  [Console]::Out.WriteLine(($props | ConvertTo-Json -Compress))
  exit 0
}

function Wait-Gone([int]$id) {
  for ($i = 0; $i -lt 40 -and (Get-Process -Id $id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
  return -not (Get-Process -Id $id -ErrorAction SilentlyContinue)
}

$self = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
if (-not $self) { Out-Result $false @{ error = 'That process has already ended.' } }
# The shell it runs in, if it runs in one. Launchers can come between, each
# started moments before the next: npm's .cmd wrappers (cmd /c), Node running
# a CLI that starts the real program, and version managers' shims, such as
# mise's and nvm's, which start the real one, sometimes through each other.
# Those end with it. Anything else, such as the terminal or an editor, stops
# the search. A parent that started after its child has only been given the
# real parent's old PID.
function Test-Shell($p) {
  if ($p.Name -eq 'cmd.exe') { return $p.CommandLine -notmatch '\s/[cC]\s' }
  return $p.Name -match '^(pwsh|powershell|nu|bash|zsh|fish)\.exe$'
}
$Launchers = '^(node|bun|deno|cmd|mise|volta|volta-shim|fnm|proto|npx|npm|pnpm|yarn|claude|codex)(-[\w.-]+)?\.exe$'
$top = $self
$shell = $null
for ($i = 0; $i -lt 8; $i++) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($top.ParentProcessId)"
  if (-not $parent -or $parent.CreationDate -gt $top.CreationDate) { break }
  if (Test-Shell $parent) { $shell = $parent; break }
  if ($parent.Name -notmatch $Launchers -or ($top.CreationDate - $parent.CreationDate).TotalSeconds -gt 30) { break }
  $top = $parent
}
# Only a launcher that's there for this session ends with it.
if (-not $shell) { $top = $self }

& taskkill.exe /PID $top.ProcessId /T /F *> $null
if (-not (Wait-Gone $TargetPid) -or -not (Wait-Gone $top.ProcessId)) { Out-Result $false @{ error = "PID $TargetPid didn't end." } }
if (-not $shell) { Out-Result $true @{ closedTab = $false } }

# Typing into the tab's console. A Ctrl+C there would otherwise end this too.
[void][C]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
[void][C]::FreeConsole()
$typed = $false
if ([C]::AttachConsole([uint32]$shell.ProcessId)) {
  try {
    $in = [C]::OpenConsoleInput()
    if ($in -ne [IntPtr]-1) {
      try {
        # Lets the shell come back to its prompt first.
        Start-Sleep -Milliseconds 300
        $typed = [C]::Type($in, "exit`r")
      } finally {
        [void][C]::CloseHandle($in)
      }
    }
  } finally {
    [void][C]::FreeConsole()
  }
}
if (-not (Wait-Gone $shell.ProcessId)) {
  Stop-Process -Id $shell.ProcessId -Force -ErrorAction SilentlyContinue
}
Out-Result $true @{ closedTab = $true; typed = $typed }
