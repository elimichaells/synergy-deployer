using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace ManagerSetup;

internal static class ServerAddress
{
    public static bool TryNormalize(string input, out string address)
    {
        address = input.Trim().ToLowerInvariant().TrimEnd('.');
        if (address.StartsWith('[') && address.EndsWith(']')) address = address[1..^1];
        if (Regex.IsMatch(address, "[\\s/%]")) return false;
        if (IPAddress.TryParse(address, out var ip))
        {
            if (ip.AddressFamily == AddressFamily.InterNetwork && !Regex.IsMatch(address, @"^\d{1,3}(\.\d{1,3}){3}$")) return false;
            if (ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any) || ip.Equals(IPAddress.Broadcast) || ip.IsIPv6Multicast
                || (ip.AddressFamily == AddressFamily.InterNetwork && ip.GetAddressBytes()[0] >= 224)) return false;
            address = ip.ToString();
            return true;
        }
        return !Regex.IsMatch(address, @"^[0-9.]+$")
            && Regex.IsMatch(address, @"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$");
    }

    public static string Url(string address) => "https://" + (address.Contains(':') ? $"[{address}]" : address);

    public static bool UsesLocalCertificate(string address, string accessMode) => accessMode == "local"
        || IPAddress.TryParse(address, out _) || !address.Contains('.')
        || Regex.IsMatch(address, @"\.(localhost|local|internal|test|invalid|home\.arpa)$");
}
