import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function publicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  return (
    isIP(normalized) === 6 &&
    /^[23][0-9a-f]{3}:/.test(normalized) &&
    !/^(?:2001:(?:db8|0):|2002:)/.test(normalized)
  );
}
export function publicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("仅支持公共HTTPS网址。");
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (!hostname.includes(".") && !isIP(hostname)) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(hostname) ||
    (isIP(hostname) && !publicAddress(hostname))
  )
    throw new Error("仅支持无登录凭据的公共HTTPS网址。");
  url.hash = "";
  return url;
}
export async function validatePublicHttpsUrl(value: string): Promise<string> {
  const url = publicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
      throw new Error("网址必须解析到公共网络地址。");
  }
  return url.href;
}
