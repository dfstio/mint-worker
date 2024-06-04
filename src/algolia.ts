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
