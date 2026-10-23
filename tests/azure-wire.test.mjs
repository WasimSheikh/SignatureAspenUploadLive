import test from "node:test";
import assert from "node:assert/strict";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

test("real Azure SDK sends conditional snapshot creation and snapshot-pinned range copy over HTTP", async () => {
  const requests = [];
  const snapshotTime = "2026-10-23T20:00:00.0000000Z";
  const credential = new StorageSharedKeyCredential("testaccount", Buffer.from("nonfunctional-test-key").toString("base64"));
  const client = new BlobServiceClient("https://testaccount.blob.core.windows.net", credential, {
    retryOptions: { maxTries: 1 },
    httpClient: {
      async sendRequest(request) {
        requests.push(request);
        const values = { etag: '"source-etag"', "x-ms-snapshot": snapshotTime, "content-length": "0",
          "x-ms-request-id": "wire-test", "x-ms-version": "2025-11-05" };
        return { request, status: 201, bodyAsText: "", headers: {
          get(name) { return values[name.toLowerCase()]; },
          toJSON() { return values; },
          toJson() { return values; },
        } };
      },
    },
  });

  test("real Azure SDK lists uncommitted-only blobs using its supported option spelling", async () => {
    let requested;
    const credential = new StorageSharedKeyCredential("testaccount", Buffer.from("nonfunctional-test-key").toString("base64"));
    const client = new BlobServiceClient("https://testaccount.blob.core.windows.net", credential, {
      retryOptions: { maxTries: 1 },
      httpClient: {
        async sendRequest(request) {
          requested = new URL(request.url);
          const values = { "content-type": "application/xml", "x-ms-request-id": "wire-list-test" };
          return { request, status: 200,
            bodyAsText: '<EnumerationResults ServiceEndpoint="https://testaccount.blob.core.windows.net/" ContainerName="test-container"><Blobs/><NextMarker/></EnumerationResults>',
            headers: { get(name) { return values[name.toLowerCase()]; }, toJson() { return values; } } };
        },
      },
    });
    await client.getContainerClient("test-container")
      .listBlobsFlat({ prefix: "staging/", includeUncommitedBlobs: true }).byPage({ maxPageSize: 500 }).next();
    assert.equal(requested.searchParams.get("include"), "uncommittedblobs");
    assert.equal(requested.searchParams.get("prefix"), "staging/");
  });
  const source = client.getContainerClient("test-container").getBlockBlobClient("staging/transfer/file/session");
  const result = await source.createSnapshot({ conditions: { ifMatch: '"source-etag"',
    leaseId: "12345678-1234-1234-1234-123456789abc" } });
  assert.equal(result.snapshot, snapshotTime);
  assert.equal(new URL(requests[0].url).searchParams.get("comp"), "snapshot");
  assert.equal(requests[0].headers.get("if-match"), '"source-etag"');
  assert.equal(requests[0].headers.get("x-ms-lease-id"), "12345678-1234-1234-1234-123456789abc");
  const final = client.getContainerClient("test-container").getBlockBlobClient("transfers/transfer/file");
  const sourceUrl = new URL(source.withSnapshot(result.snapshot).url);
  sourceUrl.searchParams.set("sig", "nonfunctional-snapshot-read-sas");
  await final.stageBlockFromURL(Buffer.from("version:000001").toString("base64"), sourceUrl.toString(), 1024, 2048);
  const copySource = new URL(requests[1].headers.get("x-ms-copy-source"));
  assert.equal(copySource.searchParams.get("snapshot"), snapshotTime);
  assert.equal(copySource.pathname, "/test-container/staging/transfer/file/session");
  assert.equal(requests[1].headers.get("x-ms-source-range"), "bytes=1024-3071");
  assert.equal(new URL(requests[1].url).pathname, "/test-container/transfers/transfer/file");
});
