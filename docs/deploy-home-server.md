# Deploying to a home server behind NAT

The generic half of the pipeline is in [the README](../README.md#deployment): three workflows,
merge-to-main is the deploy, and the runner SSHes to the host. This file is the other half — how a
runner reaches a box with no public address, and every trap that cost time getting there.

It describes **one specific topology**: a home server behind NAT, a WireGuard server already
running for other reasons, and a self-hosted-adjacent setup where only WireGuard's UDP port is
forwarded. Addresses below (`192.168.50.9`, `10.13.13.1`) are this deployment's; yours will differ.
If your host has a public address, none of this applies — set `SSH_HOST` to it and stop reading.

## Why a tunnel

A home server has no public address to SSH to, and port-forwarding 22 to get one means exposing
sshd to the internet for the sake of a job that runs a few times a week. Instead the runner joins
the WireGuard tunnel that's already there, as a peer of its own, and reaches sshd through it. Only
WireGuard's UDP port is forwarded, and it already was.

## Which address to SSH to

**`SSH_HOST` is the host's LAN address** (`192.168.50.9` in `deploy.yml`), not the WireGuard server
address.

The server address is the ambiguous one. `10.13.13.1` can belong to a bridged
`linuxserver/wireguard` container, which claims it as a local address and runs no sshd, or to a
`wg0` on the host itself, which does — and nothing about the address says which you have. Both at
once is possible too, if the container's config was ever imported onto the host. Aiming a deploy at
the wrong one gets connection refused and reads exactly like a firewall problem.

Two commands disambiguate:

```sh
docker exec wireguard ip route get 10.13.13.1   # "local … dev lo" means the container owns it
ip -brief addr show wg0                          # on the host
```

The LAN address needs neither, and it's the path every other peer already uses to reach services on
the box.

## The runner's peer config

That peer's config is the `WG_CONFIG` secret, and it wants three edits over whatever your WireGuard
server generates:

```ini
AllowedIPs = 192.168.50.9/32   # NOT the 10.13.13.0/24,192.168.50.0/24 it hands you
PersistentKeepalive = 25
# and delete the DNS = line entirely
```

`AllowedIPs` is the routing table for the tunnel, so the generated value points a CI runner at your
whole LAN — every other box in the house, one leaked secret away. The deploy needs exactly one host.

A `DNS =` line makes `wg-quick` rewrite the runner's own `resolv.conf` to your LAN resolver, which
errors out without `resolvconf` installed and breaks the runner resolving `github.com` if it isn't.

### Endpoint, and its port

`Endpoint` is your public IP, the one place it appears — **and check its port against what the
router actually forwards.** A containerised WireGuard server listens on 51820 inside the container
and gets published on some other host port, and the generator writes *that* port into every peer
config it hands out; if the router forwards the standard one to a server on the host, every
generated config points at a port nothing is listening on.

This fails in the most expensive way available: `wg-quick up` still exits 0, every key is valid, and
the packets are discarded upstream of any instance that could log them, so there is nothing to find
on either end.

If the IP is dynamic, put a DDNS name there. WireGuard resolves an Endpoint hostname only at
interface bring-up — a problem for long-lived peers, free for a runner that builds and destroys
`wg0` every run.

### Don't lock it down with `from=`

What source address sshd sees depends on which side of the box terminates the tunnel: a host-side
`wg0` hands it the peer's tunnel address intact, while a bridged container MASQUERADEs and hands it
the docker bridge address instead. Neither is a stable identity for a runner, and getting it wrong
locks you out of your own deploy for reasons no log explains. The forced command is doing the
restricting here, not the source address.

(Whichever terminates it, the interface needs to be in a firewalld zone that permits ssh.)

## Secrets

**Environment secrets, not repo secrets** — Settings → Environments → `production`, matching
`environment: production` in `deploy.yml`, with its deployment branch rule set to `main`. Repo
secrets are readable by `ci.yml` on any same-repo pull request; environment secrets only reach a job
that names the environment, and `ci.yml` doesn't.

| Secret | Value |
|---|---|
| `WG_CONFIG` | The tunnel peer config above |
| `SSH_USER` | User to connect as — needs to be in the `docker` group |
| `SSH_KEY` | Private half of a key dedicated to this and nothing else — its public half goes in the host's `authorized_keys`, behind the forced command below |
| `SSH_KNOWN_HOSTS` | One line pinning the host's key, so the deploy verifies a fingerprint instead of trusting whatever answers |

No `SSH_HOST`: it's a literal in the workflow. An RFC1918 address only reachable through the tunnel
hides nothing, and reading it in the diff beats an opaque secret when a deploy misbehaves. No
`DEPLOY_PATH` either — the host script derives it from its own location, because a path the runner
could name is a path the forced command isn't restricting.

## On the host, once

Clone the repo, write `.env` (see the README's Setup), then generate a key for this and nothing
else:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/gh_deploy -C deploy@github-actions -N ''
printf 'command="%s/deploy/host-deploy.sh",restrict %s\n' \
  "$PWD" "$(cat ~/.ssh/gh_deploy.pub)" >> ~/.ssh/authorized_keys
cat ~/.ssh/gh_deploy        # this half goes in SSH_KEY, then delete it from the host

# and this goes in SSH_KNOWN_HOSTS, verbatim
printf '192.168.50.9 %s\n' "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

`known_hosts` matching is a literal string compare, so the entry must name the **exact string the
workflow hands `ssh`** — the same address as `SSH_HOST`, whatever you set it to. Reading the host's
own key file also beats `ssh-keyscan`, which asks the network who it is; there's no reason to when
you're already standing on the machine. (`ssh-keyscan -H` is worse still here: it hashes the
hostname, so it can only ever produce an entry for the name you scanned.)

`restrict` turns off pty, agent, port and X11 forwarding — none of which a deploy needs, all of
which a stolen key would enjoy having.

## Verify before GitHub is involved

The forced command, from the host itself:

```sh
ssh -i ~/.ssh/gh_deploy you@localhost latest              # deploys
ssh -i ~/.ssh/gh_deploy you@localhost                     # same thing — not a shell
ssh -i ~/.ssh/gh_deploy you@localhost 'rm -rf /tmp/x'     # exits 64, runs nothing
```

The tunnel half separately, from a phone or laptop peer already on the VPN — and **do it off your
LAN**, on cell data rather than the house wifi, or the connection never enters the tunnel and proves
nothing. `ssh you@192.168.50.9`; any response is a pass, `Permission denied (publickey)` included,
since it means packets made the round trip. If that works and the deploy still doesn't, the problem
is the CI peer's config, not the firewall — worth knowing before you start editing zones.

Three layers have to fail before a leaked secret matters: `WG_CONFIG` routes to one address,
`SSH_KEY` is useless without it, and the forced command reduces that key to "restart the bot at a
validated tag".

## GHCR visibility

**The package has to be readable by the host**, and a public one needs no registry credentials there
at all. Check it under package → Package settings → Change visibility after the first Publish run —
not before, because a package doesn't exist to be configured until something has pushed to it. A
private one shows up as a 401 on `docker compose pull` in the deploy log; flip the visibility and
re-run, or keep it private and `docker login ghcr.io` on the host with a `read:packages` PAT.

## What CI never updates

`docker-compose.yaml` and `deploy/host-deploy.sh` live on the host too. A change to either needs a
`git pull` there.
