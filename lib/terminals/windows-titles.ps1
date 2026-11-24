# Long-running helper. For each line of space-separated PIDs read from stdin,
# prints one line of JSON: each process's console title and, when it runs in
# Windows Terminal, the window and the name of its tab if that can be told
# without switching tabs. Also lists every tab in those windows.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class T {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder sb, uint size);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
}
"@

# While attached to a session's console, a Ctrl+C typed there would otherwise
# end this process too.
[void][T]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)

$AE = [Windows.Automation.AutomationElement]
$Descendants = [Windows.Automation.TreeScope]::Descendants
$SelectionItem = [Windows.Automation.SelectionItemPattern]::Pattern
$TabCond = New-Object Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
$PaneCond = New-Object Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'TermControl')

function Get-TitleKey([string]$title) {
  return ($title -replace '^[^\p{L}\p{N}]+', '').Trim()
}

# Tab names, which one is selected, and the app titles of the selected tab's
# panes (the only panes UI Automation can see).
function Get-Tabs([IntPtr]$hwnd) {
  $window = $AE::FromHandle($hwnd)
  if ($window.Current.ClassName -ne 'CASCADIA_HOSTING_WINDOW_CLASS') { return $null }
  $tabs = @()
  $selected = $null
  foreach ($t in $window.FindAll($Descendants, $TabCond)) {
    $tabs += $t.Current.Name
    if ($t.GetCurrentPattern($SelectionItem).Current.IsSelected) { $selected = $t.Current.Name }
  }
  $panes = @(foreach ($p in $window.FindAll($Descendants, $PaneCond)) { Get-TitleKey $p.Current.HelpText })
  return @{ tabs = $tabs; selected = $selected; panes = $panes }
}

[void][T]::FreeConsole()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $sessions = @{}
  $windows = @{}
  foreach ($id in ($line -split '\s+' | Where-Object { $_ })) {
    try {
      if (-not [T]::AttachConsole([uint32]$id)) {
        # An app with a window and no console, such as Comfy Desktop: the
        # title of its main window stands in.
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowTitle) { $sessions[[string]$id] = @{ title = $p.MainWindowTitle } }
        continue
      }
      try {
        $con = [T]::GetConsoleWindow()
        $sb = New-Object Text.StringBuilder 1024
        [void][T]::GetConsoleTitle($sb, 1024)
      } finally {
        [void][T]::FreeConsole()
      }
      $session = @{ title = Get-TitleKey $sb.ToString() }
      $root = if ($con -ne [IntPtr]::Zero) { [T]::GetAncestor($con, 3) } else { [IntPtr]::Zero }
      if ($root -ne [IntPtr]::Zero -and $root -ne $con) {
        $hwnd = [string][int64]$root
        if (-not $windows.ContainsKey($hwnd)) { $windows[$hwnd] = Get-Tabs $root }
        $w = $windows[$hwnd]
        if ($w) {
          $session.window = $hwnd
          if ($session.title -and $w.selected -and $w.panes -contains $session.title) {
            $session.tab = $w.selected
          } else {
            $named = $w.tabs | Where-Object { $session.title -and (Get-TitleKey $_) -eq $session.title } | Select-Object -First 1
            if ($named) { $session.tab = $named }
          }
        }
      }
      $sessions[[string]$id] = $session
    } catch {
      # The process exited or its window closed mid-scan; skip it this round.
    }
  }
  $tabLists = @{}
  foreach ($k in $windows.Keys) { if ($windows[$k]) { $tabLists[$k] = @($windows[$k].tabs) } }
  [Console]::Out.WriteLine((@{ sessions = $sessions; windows = $tabLists } | ConvertTo-Json -Compress -Depth 5))
}
