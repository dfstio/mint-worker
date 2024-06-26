import algoliasearch from "algoliasearch";
import { ALGOLIA_KEY, ALGOLIA_PROJECT } from "../env.json";
import { loadFromIPFS } from "./ipfs";

export async function algolia(params: {
  name: string;
  ipfs: string;
  contractAddress: string;
  owner: string;
  price: string;
  chain: string;
  status: string;
  jobId?: string;
  hash?: string;
}): Promise<boolean> {
  try {
    const {
      name,
      contractAddress,
      price,
      chain,
      ipfs,
      status,
      owner,
      hash,
      jobId,
    } = params;
    const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);
    if (chain !== "devnet" && chain !== "mainnet" && chain !== "zeko") {
      console.error("Invalid chain", chain);
      return false;
    }
    const index = client.initIndex(chain);
    console.log("alWriteToken", params);
    const json = await loadFromIPFS(ipfs);
    if (name !== json.name)
      console.error("name mismatch", { name, jsonName: json.name });
    const objectID = chain + "." + contractAddress + "." + name;
    const data = {
      objectID,
      chain,
      contractAddress,
      owner,
      price,
      status,
      jobId,
      ipfs,
      hash,
      ...json,
    };

    const result = await index.saveObject(data);
    if (result.taskID === undefined) {
      console.error("mint-worker: Algolia write result is", result);
    }

    return true;
  } catch (error) {
    console.error("alWriteToken error:", { error, params });
    return false;
  }
}

export async function updatePrice(params: {
  name: string;
  contractAddress: string;
  price: string;
  chain: string;
}): Promise<boolean> {
  try {
    const { name, contractAddress, price, chain } = params;
    const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);
    if (chain !== "devnet" && chain !== "mainnet" && chain !== "zeko") {
      console.error("Invalid chain", chain);
      return false;
    }
    const index = client.initIndex(chain);
    console.log("updatePrice", params);
    const objectID = chain + "." + contractAddress + "." + name;
    const data = await index.getObject(objectID);
    if (data === undefined) {
      console.error("updatePrice: object not found", objectID);
      return false;
    }
    if ((data as any).price !== price) {
      (data as any).price = price;
      const result = await index.saveObject(data);
      if (result.taskID === undefined) {
        console.error(
          "mint-worker: updatePrice: Algolia write result is",
          result
        );
      }
    } else console.log("updatePrice: price is the same", price);

    return true;
  } catch (error) {
    console.error("mint-worker: updatePrice error:", { error, params });
    return false;
  }
}

export async function updateOwner(params: {
  name: string;
  contractAddress: string;
  owner: string;
  chain: string;
}): Promise<boolean> {
  try {
    const { name, contractAddress, owner, chain } = params;
    const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);
    if (chain !== "devnet" && chain !== "mainnet" && chain !== "zeko") {
      console.error("Invalid chain", chain);
      return false;
    }
    const index = client.initIndex(chain);
    console.log("updateOwner", params);
    const objectID = chain + "." + contractAddress + "." + name;
    const data = await index.getObject(objectID);
    if (data === undefined) {
      console.error("updatePrice: object not found", objectID);
      return false;
    }
    (data as any).price = "0";
    (data as any).owner = owner;
    const result = await index.saveObject(data);
    if (result.taskID === undefined) {
      console.error(
        "mint-worker: updateOwner: Algolia write result is",
        result
      );
    }

    return true;
  } catch (error) {
    console.error("mint-worker: updateOwner error:", { error, params });
    return false;
  }
}
