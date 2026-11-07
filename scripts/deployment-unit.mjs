/** Keep the dedicated service contract closed to hooks, resets and extra units. */
export function assertDeploymentUnit(text, nodeBinary) {
  if (!/^\/opt\/strategy-arena\/[^/]+\/bin\/node$/.test(nodeBinary))
    throw new Error("Use the dedicated application Node binary.");
  const expected = [
    "[Unit]",
    "Description=Strategy Arena standalone Next.js",
    "After=network-online.target",
    "Wants=network-online.target",
    "[Service]",
    "Type=simple",
    "User=strategy-arena",
    "Group=strategy-arena",
    "WorkingDirectory=/srv/strategy-arena/current",
    "EnvironmentFile=/etc/strategy-arena/arena.env",
    "Environment=NODE_ENV=production",
    "Environment=HOSTNAME=127.0.0.1",
    "Environment=PORT=3100",
    `ExecStart=${nodeBinary} /srv/strategy-arena/current/server.js`,
    "Restart=on-failure",
    "RestartSec=3",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "ReadWritePaths=/srv/strategy-arena/data",
    "UMask=0077",
    "[Install]",
    "WantedBy=multi-user.target",
  ];
  const actual = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Dedicated systemd unit differs from the complete allowed service contract.");
}
