import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MtlsFixture = Readonly<{
  directory: string;
  caCertificatePem: string;
  serverCertificatePem: string;
  serverPrivateKeyPem: string;
  clientCertificatePem: string;
  clientPrivateKeyPem: string;
  wrongInstallationCertificatePem: string;
  wrongInstallationPrivateKeyPem: string;
  untrustedCaCertificatePem: string;
  untrustedClientCertificatePem: string;
  untrustedClientPrivateKeyPem: string;
  cleanup(): void;
}>;

function runOpenSsl(directory: string, args: readonly string[]): void {
  execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
}

function createCertificateAuthority(directory: string, name: string): void {
  runOpenSsl(directory, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`,
    "-out", `${name}.crt`, "-days", "1", "-sha256", "-subj", `/CN=${name}`,
  ]);
}

function createCertificateRequest(directory: string, name: string, commonName: string): void {
  runOpenSsl(directory, [
    "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`,
    "-out", `${name}.csr`, "-subj", `/CN=${commonName}`,
  ]);
}

function signCertificate(
  directory: string,
  name: string,
  authorityName: string,
  extensionFile: string,
): void {
  runOpenSsl(directory, [
    "x509", "-req", "-in", `${name}.csr`, "-CA", `${authorityName}.crt`,
    "-CAkey", `${authorityName}.key`, "-CAcreateserial", "-CAserial", `${name}.srl`,
    "-out", `${name}.crt`, "-days", "1", "-sha256", "-extfile", extensionFile,
  ]);
}

function readText(directory: string, name: string): string {
  return readFileSync(join(directory, name), "utf8");
}

export function certificateFingerprint(certificatePem: string): string {
  return createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex");
}

export function createMtlsFixture(): MtlsFixture {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-mtls-"));
  try {
    writeFileSync(join(directory, "server.ext"), "subjectAltName=DNS:broker.test\nextendedKeyUsage=serverAuth\n");
    writeFileSync(join(directory, "client.ext"), "extendedKeyUsage=clientAuth\n");
    createCertificateAuthority(directory, "ca");
    createCertificateRequest(directory, "server", "broker.test");
    createCertificateRequest(directory, "client", "good-installation");
    createCertificateRequest(directory, "wrong-client", "wrong-installation");
    signCertificate(directory, "server", "ca", "server.ext");
    signCertificate(directory, "client", "ca", "client.ext");
    signCertificate(directory, "wrong-client", "ca", "client.ext");
    createCertificateAuthority(directory, "untrusted-ca");
    createCertificateRequest(directory, "untrusted-client", "untrusted-installation");
    signCertificate(directory, "untrusted-client", "untrusted-ca", "client.ext");

    let cleaned = false;
    return {
      directory,
      caCertificatePem: readText(directory, "ca.crt"),
      serverCertificatePem: readText(directory, "server.crt"),
      serverPrivateKeyPem: readText(directory, "server.key"),
      clientCertificatePem: readText(directory, "client.crt"),
      clientPrivateKeyPem: readText(directory, "client.key"),
      wrongInstallationCertificatePem: readText(directory, "wrong-client.crt"),
      wrongInstallationPrivateKeyPem: readText(directory, "wrong-client.key"),
      untrustedCaCertificatePem: readText(directory, "untrusted-ca.crt"),
      untrustedClientCertificatePem: readText(directory, "untrusted-client.crt"),
      untrustedClientPrivateKeyPem: readText(directory, "untrusted-client.key"),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
