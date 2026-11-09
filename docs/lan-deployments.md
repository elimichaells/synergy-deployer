# Deploy applications on an institution LAN

Manager can serve applications directly at private server IPs, without Cloudflare,
public DNS or a purchased domain. The same **Institution LAN / private IP** option
is available for the Manager host and connected servers.

1. Assign a fixed private IP to the target server, or reserve its DHCP address.
2. Select that server in Manager. Deploy the application with a private backend
   port, such as `127.0.0.1:3100`.
3. Open **Infrastructure → Domains & DNS → Add domain**. Select the application,
   choose **Institution LAN / private IP**, enter its server IP and an unused HTTPS
   port, then select **Add address**. A connected server's application setup also
   offers this address type before its first deployment.
4. Allow the chosen HTTPS port from the institution's client networks in the server
   firewall. App address changes do not change firewall or gateway rules.
5. Download that server's public root certificate and distribute it to client trust
   stores through Group Policy, device management or your institution's normal
   certificate procedure. Keep each server's private CA keys on that server.
6. From an institution device, open the displayed URL and check that HTTPS is
   trusted and the correct application responds.

For example, a library app can use `https://192.168.10.20:8443` and a records app on
the same server can use `https://192.168.10.20:8444`. No hostname is required. IPv4
private ranges (`10/8`, `172.16/12`, `192.168/16`) and IPv6 unique local addresses
(`fc00::/7`) are supported. The IP must belong to the selected server. Port 443 is
allowed when unused; use separate ports from 1024–65535 when other sites already
use 443. Occupied ports are rejected before replacing the proxy configuration.
Independent connected servers can use the same private address in separate LANs.

Browsers share cookies across ports on the same IP. Configure distinct cookie
names for applications sharing an IP. Manager reserves `manager_session` and
filters it from private-IP application requests and responses; its own sign-in
route retains the cookie. Use separate internal hostnames when applications need
separate browser cookie namespaces.

Caddy issues and renews local certificates. Devices without the root certificate
show a browser trust warning. Each server has its own CA; downloading a remote
server's certificate does not download the Manager host's certificate. Private-IP
routes reject peers outside private and loopback ranges. Scope firewall rules to
the actual institution networks as well: a reverse proxy, VPN or tunnel may appear
as a private peer. Application backend ports and Caddy administration ports should
remain private.

Existing public domains and sites keep their routes. Adding a primary address
changes the application's displayed URL without deleting its other routes. An
agent update to 1.8.0 or later is required for IP-only deployment; older agents
cannot claim these operations.

When reusing a separately owned Caddy installation, its administrator must include
`skip_install_trust` in the existing global options. The agent checks this before
adding local HTTPS; it cannot rewrite that owner's global configuration. This
prevents certificate-store prompts from blocking an unattended proxy. New Manager
and dedicated agent proxies configure it automatically.

The Manager must be able to reach the server for SSH onboarding. For another LAN
behind NAT, establish routed/VPN access or use manual agent enrollment from that
LAN. The enrolled agent needs outbound HTTPS to Manager. Local HTTPS issuance
does not need internet, but initial dependency installation, Git cloning and builds
still need access to their sources or institution mirrors. This feature does not
make installation or builds fully offline.

To install Manager itself inside the institution, use the Windows installer's
**Local / institution LAN** access mode and private IP or internal hostname. See
the [installer guide](../installer/ManagerSetup/README.md).
