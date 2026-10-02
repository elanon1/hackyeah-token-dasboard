# Deployment and operations

The application is self-contained ESM, serves its static dashboard and API on port 4318, and uses Node's built-in SQLite. No separate frontend process, package download, analytics service or external database is required.

## GitOps layout

`elanon1/argocd`:

```text
gitops/argo/apps/hackyeah-token-dashboard.yaml
gitops/apps/hackyeah-token-dashboard/application.yaml
gitops/apps/hackyeah-token-dashboard/source-configmap.yaml
gitops/apps/hackyeah-token-dashboard/README.md
```

`application.yaml` contains the Deployment, PVC, Service, Ingress and NetworkPolicy. Source is an immutable ConfigMap named by its content checksum. The generator takes an exact public source commit; `HTM_SOURCE_COMMIT` makes the dashboard's participant install command use that revision. Regenerate both files together for every app change:

```sh
node scripts/gitops.mjs --revision FULL_COMMIT_SHA --out /path/to/argocd/gitops/apps/hackyeah-token-dashboard
```

The generator never commits or pushes. Review and commit the files in `argocd` together. Its Argo root application discovers the new child Application automatically. Automatic sync intentionally does not prune the PVC or historical source ConfigMaps; remove obsolete ConfigMaps deliberately after verifying a successful upgrade.

## Network and certificates

`*.elcloud.pl` currently resolves to `100.100.79.68`, the organizer's Tailscale endpoint. Dashboard viewers and participant clients must have authorized network access. This is not a publicly routable endpoint. Before an event with external participants, provide a public HTTPS endpoint or arrange restricted network access; team keys do not provide network connectivity.

TLS uses the existing `letsencrypt-dns` ClusterIssuer (OVH DNS-01), configured in `gitops/argo/apps/cert-manager-webhook-ovh.yaml`. HTTP-01 cannot validate this tailnet address. The issuer requires the existing out-of-band `ovh-credentials` Secret in namespace `cert-manager`; no DNS credentials are included in this application.

## First run

1. Check Argo sync and pod readiness. Ingress host: `hackyeah.elcloud.pl`, class `traefik`, ClusterIssuer `letsencrypt-dns`.
2. Read `/data/server-secrets.json` through `kubectl exec` (see README). No application key is in Git, container images, URLs or server startup logs.
3. Open HTTPS, sign in with `adminKey`, and create teams. Give `viewKey` only to observers/projectors.
4. Complete one real Claude Code and Codex turn, check `htm status`, and verify counters before enrolling everyone.

## Data and recovery

- Keep `replicas: 1` and `Recreate` for SQLite. A rolling update or multiple pods over one SQLite database is unsupported.
- PVC uses the cluster's default storage class. Pod UID/GID and fsGroup are 1000. For network filesystems that do not support SQLite locking, use a suitable block/local disk instead.
- Database, WAL files and server keys persist under `/data`. Back up using SQLite's backup API or stop the pod before copying the full directory; do not copy a live `.sqlite` file without its WAL.
- To rotate organizer/view keys: update the secret file securely and restart the pod. Team keys are rotated separately in the organizer desk.
- To start a separate event, use a fresh data directory/PVC and have participants enroll with a fresh explicit home. Do not silently reuse a previous event's identities or data.
- Expose only HTTPS. The NetworkPolicy permits ingress to the app's HTTP port within the cluster, denies all outbound traffic, and relies on application keys for authorization. It does not claim to rate-limit a distributed attack; add reverse-proxy protections for a large public event.
- Health checks prove the process is serving; check `/api/summary` with a viewer key to verify authenticated database reads. `/api/health` does not reveal secrets.

## Optional container image workflow

The included Dockerfile builds a normal non-root image if you prefer an internal registry. The initial GitOps deployment uses digest-pinned official Node plus read-only source ConfigMap to avoid needing registry setup. This is suitable while the entire source remains below Kubernetes's ConfigMap size limit (the generator enforces 900 KiB). Move to a built, signed image if the project grows.
