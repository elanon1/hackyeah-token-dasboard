import { parseArgs } from "node:util";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const { values } = parseArgs({
  options: { revision: { type: "string" }, out: { type: "string" } },
});
if (!/^[a-f0-9]{40}$/.test(values.revision || "") || !values.out)
  throw new Error(
    "Usage: node scripts/gitops.mjs --revision FULL_COMMIT_SHA --out OUTPUT_DIRECTORY",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = [
  "package.json",
  ...["bin", "src", "public"].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((x) => /\.(js|html|css|svg|ttf|txt)$/.test(x))
      .map((x) => `${dir}/${x}`),
  ),
].sort();
const source = Object.fromEntries(
  paths.map((path) => [
    path,
    readFileSync(join(root, path), path.endsWith(".ttf") ? "base64" : "utf8"),
  ]),
);
const digest = createHash("sha256")
  .update(JSON.stringify(source))
  .digest("hex");
const sourceName = `hackyeah-source-${digest.slice(0, 12)}`;
const data = Object.fromEntries(
  Object.entries(source)
    .filter(([path]) => !path.endsWith(".ttf"))
    .map(([path, content]) => [path.replaceAll("/", "__"), content]),
);
// JSON is valid YAML; JSON escaping keeps source exact and reviewable.
const configmap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: {
    name: sourceName,
    namespace: "hackyeah",
    labels: { app: "hackyeah-token-dashboard" },
    annotations: {
      "hackyeah/source-commit": values.revision,
      "hackyeah/source-sha256": digest,
    },
  },
  immutable: true,
  data,
  binaryData: Object.fromEntries(
    Object.entries(source)
      .filter(([path]) => path.endsWith(".ttf"))
      .map(([path, content]) => [path.replaceAll("/", "__"), content]),
  ),
};
const configText = JSON.stringify(configmap, null, 2) + "\n";
if (Buffer.byteLength(configText) > 900 * 1024)
  throw new Error(
    "Source too large for ConfigMap; switch to a container image.",
  );
const app = "hackyeah-token-dashboard";
const objects = [
  {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: app,
      namespace: "hackyeah",
      annotations: {
        "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "1Gi" } },
    },
  },
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: app, namespace: "hackyeah" },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app } },
      template: {
        metadata: {
          labels: { app },
          annotations: {
            "hackyeah/source-commit": values.revision,
            "hackyeah/source-sha256": digest,
          },
        },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "meter",
              image:
                "node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1",
              imagePullPolicy: "IfNotPresent",
              command: [
                "node",
                "--disable-warning=ExperimentalWarning",
                "/app/bin/htm.js",
                "server",
                "--host",
                "0.0.0.0",
                "--data",
                "/data",
              ],
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "HTM_SOURCE_COMMIT", value: values.revision },
              ],
              ports: [{ name: "http", containerPort: 4318 }],
              securityContext: {
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "50m", memory: "96Mi" },
                limits: { cpu: "1", memory: "384Mi" },
              },
              volumeMounts: [
                { name: "source", mountPath: "/app", readOnly: true },
                { name: "data", mountPath: "/data" },
              ],
              startupProbe: {
                httpGet: { path: "/api/health", port: "http" },
                periodSeconds: 3,
                failureThreshold: 20,
              },
              readinessProbe: {
                httpGet: { path: "/api/health", port: "http" },
                periodSeconds: 5,
              },
              livenessProbe: {
                httpGet: { path: "/api/health", port: "http" },
                periodSeconds: 20,
              },
            },
          ],
          volumes: [
            {
              name: "source",
              configMap: {
                name: sourceName,
                defaultMode: 292,
                items: paths.map((path) => ({
                  key: path.replaceAll("/", "__"),
                  path,
                })),
              },
            },
            { name: "data", persistentVolumeClaim: { claimName: app } },
          ],
        },
      },
    },
  },
  {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: app, namespace: "hackyeah" },
    spec: {
      selector: { app },
      ports: [{ name: "http", port: 80, targetPort: "http" }],
    },
  },
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: app,
      namespace: "hackyeah",
      annotations: {
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "traefik.ingress.kubernetes.io/router.tls": "true",
      },
    },
    spec: {
      ingressClassName: "traefik",
      tls: [
        { hosts: ["hackyeah.elanon.pl"], secretName: "hackyeah-elanon-pl-tls" },
      ],
      rules: [
        {
          host: "hackyeah.elanon.pl",
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name: app, port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  },
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: app, namespace: "hackyeah" },
    spec: {
      podSelector: { matchLabels: { app } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ ports: [{ port: 4318, protocol: "TCP" }] }],
      egress: [],
    },
  },
];
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "source-configmap.yaml"), configText);
writeFileSync(
  join(out, "application.yaml"),
  objects.map((x) => JSON.stringify(x, null, 2)).join("\n---\n") + "\n",
);
console.log(
  JSON.stringify({
    revision: values.revision,
    sourceName,
    sha256: digest,
    bytes: Buffer.byteLength(configText),
    output: out,
  }),
);
