function Get-ManagerNetworkSettings([string]$Address, [string]$AccessMode = 'public', [string[]]$AllowedNetworks = @('LocalSubnet')) {
    $addressValue = $Address.Trim().ToLowerInvariant().TrimEnd('.')
    $ip = $null
    if ($addressValue.StartsWith('[') -and $addressValue.EndsWith(']')) { $addressValue = $addressValue.Substring(1, $addressValue.Length - 2) }
    if ($addressValue -match '[\s/%]') { throw 'Enter an IP address or hostname without a scheme, path, port, or zone identifier.' }
    $isIp = [Net.IPAddress]::TryParse($addressValue, [ref]$ip)
    if ($isIp) {
        if ($ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $addressValue -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Enter a complete dotted IPv4 address.' }
        if ($ip.Equals([Net.IPAddress]::Any) -or $ip.Equals([Net.IPAddress]::IPv6Any) -or $ip.Equals([Net.IPAddress]::Broadcast) -or $ip.IsIPv6Multicast -or
            ($ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $ip.GetAddressBytes()[0] -ge 224)) { throw 'Enter a usable server address, not a wildcard or multicast address.' }
        $addressValue = $ip.ToString()
    } elseif ($addressValue -notmatch '^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' -or $addressValue -match '^[0-9.]+$') {
        throw 'Enter a valid IP address or hostname without a scheme, path, or port.'
    }
    if ($AccessMode -notin @('local','public')) { throw 'ManagerAccessMode must be local or public.' }
    $siteAddress = if ($isIp -and $ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { '[' + $addressValue + ']' } else { $addressValue }
    $internalTls = $AccessMode -eq 'local' -or $isIp -or -not $addressValue.Contains('.') -or $addressValue -match '\.(localhost|local|internal|test|invalid|home\.arpa)$'
    $remoteAddresses = @('Any')
    if ($AccessMode -eq 'local') {
        if (-not $AllowedNetworks.Count) { throw 'Local installations require LocalSubnet or at least one allowed client IP/CIDR.' }
        foreach ($network in $AllowedNetworks) {
            if ($network -eq 'LocalSubnet') { continue }
            $parts = $network.Split('/')
            $networkIp = $null
            if ($parts.Count -gt 2 -or -not [Net.IPAddress]::TryParse($parts[0], [ref]$networkIp)) { throw ('Invalid allowed client network: ' + $network) }
            if ($parts.Count -eq 2) {
                $maxPrefix = if ($networkIp.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) { 32 } else { 128 }
                $prefix = 0
                if (-not [int]::TryParse($parts[1], [ref]$prefix) -or $prefix -lt 1 -or $prefix -gt $maxPrefix) { throw ('Invalid allowed client network prefix: ' + $network) }
            }
        }
        $remoteAddresses = $AllowedNetworks
    }
    return [pscustomobject]@{
        Address=$addressValue; SiteAddress=$siteAddress; Url=('https://' + $siteAddress)
        TlsMode=$(if ($internalTls) { 'internal' } else { 'public' })
        RemoteAddresses=$remoteAddresses
        LogName=($addressValue -replace '[^a-z0-9-]', '-')
    }
}
