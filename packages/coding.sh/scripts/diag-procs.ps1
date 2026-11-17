# DIAGNOSTICS ONLY (throwaway branch). Every 1.5 s: one line with the cumulative CPU time,
# bytes read and written, and working set of every process on the machine.
param([string]$Out)
$q = "select Name,ProcessId,ParentProcessId,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,WorkingSetSize from Win32_Process"
$i = 0
while ($true) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $sb = New-Object System.Text.StringBuilder
  try {
    foreach ($p in (Get-CimInstance -Query $q)) {
      [void]$sb.Append($p.Name).Append('|').Append($p.ProcessId).Append('|').Append($p.ParentProcessId).Append('|').Append([int64](($p.KernelModeTime + $p.UserModeTime) / 10000)).Append('|').Append($p.ReadTransferCount).Append('|').Append($p.WriteTransferCount).Append('|').Append([int64]($p.WorkingSetSize / 1MB)).Append(';')
    }
  } catch { [void]$sb.Append("ERR " + $_.Exception.Message) }
  $t2 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [System.IO.File]::AppendAllText($Out, "$t $($t2 - $t) $($sb.ToString())`n")
  $i++
  if ($i % 8 -eq 1) {
    try {
      $sv = (Get-CimInstance -Query "select Name,ProcessId from Win32_Service where State='Running'" | ForEach-Object { "$($_.Name):$($_.ProcessId)" }) -join ','
      [System.IO.File]::AppendAllText("$Out.services", "$t $sv`n")
      $cl = (Get-CimInstance -Query "select ProcessId,CommandLine from Win32_Process where Name='chrome.exe'" | ForEach-Object { $m = [regex]::Match([string]$_.CommandLine, '--type=(\S+)'); $u = [regex]::Match([string]$_.CommandLine, '--utility-sub-type=(\S+)'); "$($_.ProcessId):$($m.Groups[1].Value)$($u.Groups[1].Value)" }) -join ','
      [System.IO.File]::AppendAllText("$Out.chrome", "$t $cl`n")
    } catch {}
  }
  Start-Sleep -Milliseconds 1500
}
