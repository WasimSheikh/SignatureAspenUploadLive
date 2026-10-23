import { BlobServiceClient, StorageSharedKeyCredential, BlobSASPermissions, SASProtocol, generateBlobSASQueryParameters } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { config } from "./config.js";

let client, credential, delegation, refreshing;
export function storage() {
  if (!client) {
    const settings = config();
    credential = settings.storageAccountKey
      ? new StorageSharedKeyCredential(settings.storageAccount, settings.storageAccountKey)
      : new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined });
    client = new BlobServiceClient(`https://${settings.storageAccount}.blob.core.windows.net`, credential, {
      retryOptions: { maxTries: 3, tryTimeoutInMs: 15000 },
    });
  }
  return client;
}

export function container() {
  return storage().getContainerClient(config().storageContainer);
}

export async function blobSas(blobName, permissions, expiresOn, response = {}) {
  storage();
  const settings = config();
  const now = Date.now();
  const startsOn = new Date(now - 5 * 60 * 1000);
  const options = {
    containerName: settings.storageContainer, blobName, permissions: BlobSASPermissions.parse(permissions),
    protocol: SASProtocol.Https, startsOn, expiresOn, ...response,
  };
  let query;
  if (credential instanceof StorageSharedKeyCredential) {
    query = generateBlobSASQueryParameters(options, credential);
  } else {
    if (!delegation || delegation.signedExpiresOn.getTime() < expiresOn.getTime() + 60000) {
      if (!refreshing) {
        refreshing = storage().getUserDelegationKey(startsOn, new Date(now + 60 * 60 * 1000))
          .then((key) => { delegation = key; }).finally(() => { refreshing = undefined; });
      }
      await refreshing;
    }
    query = generateBlobSASQueryParameters(options, delegation, settings.storageAccount);
  }
  const url = new URL(`${container().getBlockBlobClient(blobName).url}?${query.toString()}`);
  if (response.snapshotTime) url.searchParams.set("snapshot", response.snapshotTime);
  return url.toString();
}
