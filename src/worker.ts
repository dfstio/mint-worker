import {
  zkCloudWorker,
  Cloud,
  DeployedSmartContract,
  fetchMinaAccount,
  accountBalanceMina,
  initBlockchain,
} from "zkcloudworker";
import {
  VerificationKey,
  PublicKey,
  Mina,
  Field,
  Cache,
  AccountUpdate,
  Encoding,
} from "o1js";
import {
  NFTContractV2,
  NameContractV2,
  VERIFICATION_KEY_HASH_V2,
  VERIFICATION_KEY_V2,
  MintParams,
  deserializeFields,
} from "minanft";
import { transactionParams, deserializeTransaction } from "./deserialize";
import { algolia } from "./algolia";

export class MintWorker extends zkCloudWorker {
  static nftVerificationKey: VerificationKey | undefined = undefined;
  static nameVerificationKey: VerificationKey | undefined = undefined;
  readonly cache: Cache;

  constructor(cloud: Cloud) {
    super(cloud);
    this.cache = Cache.FileSystem(this.cloud.cache);
  }

  public async deployedContracts(): Promise<DeployedSmartContract[]> {
    throw new Error("not implemented");
  }

  private async compile(): Promise<void> {
    try {
      console.time("compiled");
      if (MintWorker.nameVerificationKey === undefined) {
        MintWorker.nftVerificationKey = (
          await NFTContractV2.compile({ cache: this.cache })
        ).verificationKey;
        if (
          MintWorker.nftVerificationKey.hash.toBigInt() !==
          VERIFICATION_KEY_V2.hash.toBigInt()
        ) {
          console.error(
            "Verification key mismatch",
            MintWorker.nftVerificationKey.hash.toJSON(),
            VERIFICATION_KEY_V2.hash.toJSON()
          );
          return;
        }
        MintWorker.nameVerificationKey = (
          await NameContractV2.compile({ cache: this.cache })
        ).verificationKey;
        if (
          MintWorker.nameVerificationKey.hash.toJSON() !==
          VERIFICATION_KEY_HASH_V2
        ) {
          console.error(
            "Name verification key mismatch",
            MintWorker.nameVerificationKey.hash.toJSON(),
            VERIFICATION_KEY_HASH_V2
          );
          return;
        }
      }
      console.timeEnd("compiled");
    } catch (error) {
      console.error("Error in compile, restarting container", error);
      // Restarting the container, see https://github.com/o1-labs/o1js/issues/1651
      await this.cloud.forceWorkerRestart();
      throw error;
    }
  }

  public async create(transaction: string): Promise<string | undefined> {
    throw new Error("not implemented");
  }

  public async merge(
    proof1: string,
    proof2: string
  ): Promise<string | undefined> {
    throw new Error("not implemented");
  }

  public async execute(transactions: string[]): Promise<string | undefined> {
    if (this.cloud.args === undefined)
      throw new Error("this.cloud.args is undefined");
    const args = JSON.parse(this.cloud.args);
    console.log("args", args);
    if (args.contractAddress === undefined)
      throw new Error("args.contractAddress is undefined");

    switch (this.cloud.task) {
      case "mint":
        return await this.sendTx({
          contractAddress: args.contractAddress,
          transactions,
        });

      default:
        throw new Error(`Unknown task: ${this.cloud.task}`);
    }
  }

  private async sendTx(args: {
    contractAddress: string;
    transactions: string[];
  }): Promise<string> {
    if (this.cloud.chain !== "devnet") return "Only devnet is supported";
    if (args.transactions.length === 0) {
      return "No transactions to send";
    }
    await initBlockchain(this.cloud.chain);

    const { serializedTransaction, signedData, mintParams } = JSON.parse(
      args.transactions[0]
    );
    const contractAddress = PublicKey.fromBase58(args.contractAddress);
    const mintData = MintParams.fromFields(
      deserializeFields(mintParams),
      []
    ) as MintParams;
    const { fee, sender, nonce, memo } = transactionParams(
      serializedTransaction
    );
    const ipfs = mintData.metadataParams.storage.toIpfsHash();
    const price = mintData.price.toBigInt().toString();
    const name = Encoding.stringFromFields([mintData.name]);
    await algolia({
      name,
      ipfs,
      contractAddress: args.contractAddress,
      owner: sender.toBase58(),
      price,
      chain: this.cloud.chain,
      status: "created",
      jobId: this.cloud.jobId,
    });

    await this.compile();
    console.time("prepared tx");

    const zkApp = new NameContractV2(contractAddress);
    await fetchMinaAccount({
      publicKey: contractAddress,
      force: true,
    });
    await fetchMinaAccount({
      publicKey: sender,
      force: true,
    });
    const txNew = await Mina.transaction(
      { sender, fee, nonce, memo },
      async () => {
        AccountUpdate.fundNewAccount(sender);
        await zkApp.mint(mintData);
      }
    );
    const tx = deserializeTransaction(serializedTransaction, txNew);
    //if (tx === undefined) throw new Error("tx is undefined");
    const signedJson = JSON.parse(signedData);
    //console.log("SignedJson", signedJson);

    tx.transaction.feePayer.authorization =
      signedJson.zkappCommand.feePayer.authorization;
    tx.transaction.accountUpdates[0].authorization.signature =
      signedJson.zkappCommand.accountUpdates[0].authorization.signature;
    tx.transaction.accountUpdates[2].authorization.signature =
      signedJson.zkappCommand.accountUpdates[2].authorization.signature;
    tx.transaction.accountUpdates[3].authorization.signature =
      signedJson.zkappCommand.accountUpdates[3].authorization.signature;
    console.timeEnd("prepared tx");

    try {
      console.time("proved tx");
      await tx.prove();
      console.timeEnd("proved tx");

      console.log(`Sending tx...`);
      console.log("sender:", sender.toBase58());
      console.log("Sender balance:", await accountBalanceMina(sender));
      const txSent = await tx.safeSend();
      if (txSent?.status == "pending") {
        console.log(`tx sent: hash: ${txSent?.hash} status: ${txSent?.status}`);
        await algolia({
          name,
          ipfs,
          contractAddress: args.contractAddress,
          owner: sender.toBase58(),
          price,
          chain: this.cloud.chain,
          status: "pending",
          jobId: this.cloud.jobId,
          hash: txSent?.hash,
        });
      } else {
        console.log(
          `tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status}`,
          txSent
        );
        await algolia({
          name,
          ipfs,
          contractAddress: args.contractAddress,
          owner: sender.toBase58(),
          price,
          chain: this.cloud.chain,
          status: "failed",
          jobId: this.cloud.jobId,
          hash: txSent?.hash,
        });
        return "Error sending transaction";
      }
      return txSent?.hash ?? "Error sending transaction";
    } catch (error) {
      console.error("Error sending transaction", error);
      return "Error sending transaction";
    }
  }
}

export async function zkcloudworker(cloud: Cloud): Promise<zkCloudWorker> {
  return new MintWorker(cloud);
}
