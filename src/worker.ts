import {
  zkCloudWorker,
  Cloud,
  fetchMinaAccount,
  accountBalanceMina,
} from "zkcloudworker";
import {
  VerificationKey,
  PublicKey,
  Mina,
  Field,
  Cache,
  Encoding,
  UInt64,
  PrivateKey,
  Signature,
  UInt32,
} from "o1js";
import {
  NFTContractV2,
  NameContractV2,
  VERIFICATION_KEY_V2_JSON,
  MintParams,
  SellParams,
  BuyParams,
  deserializeFields,
  initBlockchain,
  blockchain,
  MinaNFT,
  RollupNFT,
  FileData,
  MINANFT_NAME_SERVICE_V2,
  wallet,
  api,
  serializeFields,
} from "minanft";
import {
  transactionParams,
  deserializeTransaction,
  serializeTransaction,
} from "./transaction";
import {
  algolia,
  updatePrice,
  updateOwner,
  algoliaTransaction,
} from "./algolia";
import { MINANFT_JWT, PINATA_JWT } from "../env.json";

export class MintWorker extends zkCloudWorker {
  static nftVerificationKey: VerificationKey | undefined = undefined;
  static nameVerificationKey: VerificationKey | undefined = undefined;
  readonly cache: Cache;

  constructor(cloud: Cloud) {
    super(cloud);
    this.cache = Cache.FileSystem(this.cloud.cache);
  }

  private async compile(): Promise<void> {
    try {
      console.time("compiled");
      if (this.cloud.chain !== "devnet" && this.cloud.chain !== "mainnet") {
        console.error("Invalid chain", this.cloud.chain);
        return;
      }
      if (MintWorker.nameVerificationKey === undefined) {
        MintWorker.nftVerificationKey = (
          await NFTContractV2.compile({ cache: this.cache })
        ).verificationKey;
        if (
          MintWorker.nftVerificationKey.hash.toJSON() !==
          VERIFICATION_KEY_V2_JSON[this.cloud.chain]?.hash
        ) {
          console.error(
            "Verification key mismatch",
            MintWorker.nftVerificationKey.hash.toJSON(),
            VERIFICATION_KEY_V2_JSON[this.cloud.chain]?.hash
          );
          return;
        }
        MintWorker.nameVerificationKey = (
          await NameContractV2.compile({ cache: this.cache })
        ).verificationKey;
        if (
          MintWorker.nameVerificationKey.hash.toJSON() !==
          VERIFICATION_KEY_V2_JSON[this.cloud.chain]?.nameHash
        ) {
          console.error(
            "Name verification key mismatch",
            MintWorker.nameVerificationKey.hash.toJSON(),
            VERIFICATION_KEY_V2_JSON[this.cloud.chain]?.nameHash
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
        return await this.mint({
          contractAddress: args.contractAddress,
          transactions,
        });

      case "sell":
        return await this.sell({
          contractAddress: args.contractAddress,
          transactions,
        });

      case "buy":
        return await this.buy({
          contractAddress: args.contractAddress,
          transactions,
        });

      case "prepare":
        return await this.prepare({
          contractAddress: args.contractAddress,
          transactions,
        });

      default:
        throw new Error(`Unknown task: ${this.cloud.task}`);
    }
  }

  private async buy(args: {
    contractAddress: string;
    transactions: string[];
  }): Promise<string> {
    if (args.transactions.length === 0) {
      return "No transactions to send";
    }
    try {
      console.log("chain:", this.cloud.chain);
      await initBlockchain(this.cloud.chain as blockchain);

      const { serializedTransaction, signedData, buyParams, name } = JSON.parse(
        args.transactions[0]
      );
      const signedJson = JSON.parse(signedData);
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      const buyData = BuyParams.fromFields(
        deserializeFields(buyParams)
      ) as MintParams;
      const { fee, sender, nonce, memo } = transactionParams(
        serializedTransaction,
        signedJson
      );
      console.log("fee", fee.toBigInt());
      const price = buyData.price.toBigInt().toString();
      const address = buyData.address;

      await this.compile();
      console.time("prepared tx");

      const zkApp = new NameContractV2(contractAddress);
      const tokenId = zkApp.deriveTokenId();
      await fetchMinaAccount({
        publicKey: contractAddress,
        force: true,
      });
      await fetchMinaAccount({
        publicKey: sender,
        force: true,
      });
      await fetchMinaAccount({
        publicKey: address,
        tokenId,
        force: true,
      });

      const txNew = await Mina.transaction(
        { sender, fee, nonce, memo },
        async () => {
          await zkApp.buy(buyData);
        }
      );

      console.log("txNew", txNew);
      console.log("SignedJson", signedJson);
      const tx = deserializeTransaction(
        serializedTransaction,
        txNew,
        signedJson
      );
      if (tx === undefined) throw new Error("tx is undefined");

      console.timeEnd("prepared tx");

      console.time("proved tx");
      await tx.prove();
      console.timeEnd("proved tx");

      console.log(`Sending tx...`);
      console.log("sender:", sender.toBase58());
      console.log("Sender balance:", await accountBalanceMina(sender));
      const txSent = await tx.safeSend();
      await algoliaTransaction({
        jobId: this.cloud.jobId,
        name,
        contractAddress: args.contractAddress,
        chain: this.cloud.chain,
        hash: txSent?.hash,
        status: txSent?.status,
        operation: "buy",
        price,
        sender: sender.toBase58(),
      });
      if (txSent?.status === "pending") {
        console.log(`tx sent: hash: ${txSent?.hash} status: ${txSent?.status}`);
        await updateOwner({
          name,
          contractAddress: args.contractAddress,
          owner: sender.toBase58(),
          chain: this.cloud.chain,
        });
        await this.cloud.publishTransactionMetadata({
          txId: txSent?.hash,
          metadata: {
            events: [{ type: "buy", name, price, buyer: sender.toBase58() }],
            actions: [],
            custom: {},
          },
        });
      } else {
        console.log(
          `tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status}`,
          txSent
        );
        return `Error sending transaction, ${
          txSent?.hash ? "hash: " + txSent?.hash : ""
        } ${txSent?.status ? "status: " + txSent?.status : ""}
        ${txSent?.errors[0] ? "error: " + txSent?.errors[0] : ""}`;
      }
      return (
        txSent?.hash ??
        `Error sending transaction, ${
          txSent?.hash ? "hash: " + txSent?.hash : ""
        } ${txSent?.status ? "status: " + txSent?.status : ""}
      ${txSent?.errors[0] ? "error: " + txSent?.errors[0] : ""}`
      );
    } catch (error) {
      console.error("Error sending transaction", error);
      return "Error sending transaction";
    }
  }

  private async sell(args: {
    contractAddress: string;
    transactions: string[];
  }): Promise<string> {
    if (args.transactions.length === 0) {
      return "No transactions to send";
    }
    try {
      console.log("chain:", this.cloud.chain);
      await initBlockchain(this.cloud.chain as blockchain);

      const { serializedTransaction, signedData, sellParams, name } =
        JSON.parse(args.transactions[0]);
      const signedJson = JSON.parse(signedData);
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      const sellData = SellParams.fromFields(
        deserializeFields(sellParams)
      ) as MintParams;
      const { fee, sender, nonce, memo } = transactionParams(
        serializedTransaction,
        signedJson
      );
      console.log("fee", fee.toBigInt());
      const price = sellData.price.toBigInt().toString();
      const address = sellData.address;

      await this.compile();
      console.time("prepared tx");

      const zkApp = new NameContractV2(contractAddress);
      const tokenId = zkApp.deriveTokenId();
      await fetchMinaAccount({
        publicKey: contractAddress,
        force: true,
      });
      await fetchMinaAccount({
        publicKey: sender,
        force: true,
      });
      await fetchMinaAccount({
        publicKey: address,
        tokenId,
        force: true,
      });

      const txNew = await Mina.transaction(
        { sender, fee, nonce, memo },
        async () => {
          await zkApp.sell(sellData);
        }
      );

      console.log("txNew", txNew);
      console.log("SignedJson", signedJson);
      const tx = deserializeTransaction(
        serializedTransaction,
        txNew,
        signedJson
      );
      if (tx === undefined) throw new Error("tx is undefined");

      console.timeEnd("prepared tx");

      console.time("proved tx");
      await tx.prove();
      console.timeEnd("proved tx");

      console.log(`Sending tx...`);
      console.log("sender:", sender.toBase58());
      console.log("Sender balance:", await accountBalanceMina(sender));
      const txSent = await tx.safeSend();
      await algoliaTransaction({
        jobId: this.cloud.jobId,
        name,
        contractAddress: args.contractAddress,
        chain: this.cloud.chain,
        hash: txSent?.hash,
        status: txSent?.status,
        operation: "sell",
        price,
        sender: sender.toBase58(),
      });
      if (txSent?.status == "pending") {
        console.log(`tx sent: hash: ${txSent?.hash} status: ${txSent?.status}`);
        await updatePrice({
          name,
          contractAddress: args.contractAddress,
          price,
          chain: this.cloud.chain,
        });
        await this.cloud.publishTransactionMetadata({
          txId: txSent?.hash,
          metadata: {
            events: [{ type: "sell", name, price, seller: sender.toBase58() }],
            actions: [],
            custom: {},
          },
        });
      } else {
        console.log(
          `tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status}`,
          txSent
        );
        return `Error sending transaction, ${
          txSent?.hash ? "hash: " + txSent?.hash : ""
        } ${txSent?.status ? "status: " + txSent?.status : ""}
        ${txSent?.errors[0] ? "error: " + txSent?.errors[0] : ""}`;
      }
      return (
        txSent?.hash ??
        `Error sending transaction, ${
          txSent?.hash ? "hash: " + txSent?.hash : ""
        } ${txSent?.status ? "status: " + txSent?.status : ""}
      ${txSent?.errors[0] ? "error: " + txSent?.errors[0] : ""}`
      );
    } catch (error) {
      console.error("Error sending transaction", error);
      return "Error sending transaction";
    }
  }

  private async mint(args: {
    contractAddress: string;
    transactions: string[];
  }): Promise<string> {
    if (args.transactions.length === 0) {
      return "No transactions to send";
    }
    let algoliaData: any;
    try {
      console.log("chain:", this.cloud.chain);
      await initBlockchain(this.cloud.chain as blockchain);

      const { serializedTransaction, signedData, mintParams } = JSON.parse(
        args.transactions[0]
      );
      const signedJson = JSON.parse(signedData);
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      const mintData = MintParams.fromFields(
        deserializeFields(mintParams),
        []
      ) as MintParams;

      const { fee, sender, nonce, memo } = transactionParams(
        serializedTransaction,
        signedJson
      );
      const ipfs = mintData.metadataParams.storage.toIpfsHash();
      const price = mintData.price.toBigInt().toString();
      const name = Encoding.stringFromFields([mintData.name]);
      algoliaData = {
        name,
        ipfs,
        contractAddress: args.contractAddress,
        owner: sender.toBase58(),
        price,
        chain: this.cloud.chain,
        jobId: this.cloud.jobId,
      };
      await algolia({
        ...algoliaData,
        status: "created",
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
          //AccountUpdate.fundNewAccount(sender);
          await zkApp.mint(mintData);
        }
      );

      //console.log("SignedJson", signedJson);
      const tx = deserializeTransaction(
        serializedTransaction,
        txNew,
        signedJson
      );
      //if (tx === undefined) throw new Error("tx is undefined");

      /*
      tx.transaction.feePayer.authorization =
        signedJson.zkappCommand.feePayer.authorization;
      tx.transaction.accountUpdates[0].authorization.signature =
        signedJson.zkappCommand.accountUpdates[0].authorization.signature;
      tx.transaction.accountUpdates[2].authorization.signature =
        signedJson.zkappCommand.accountUpdates[2].authorization.signature;
      tx.transaction.accountUpdates[3].authorization.signature =
        signedJson.zkappCommand.accountUpdates[3].authorization.signature;
      */
      console.timeEnd("prepared tx");

      console.time("proved tx");
      await tx.prove();
      console.timeEnd("proved tx");

      console.log(`Sending tx...`);
      console.log("sender:", sender.toBase58());
      console.log("Sender balance:", await accountBalanceMina(sender));
      const txSent = await tx.safeSend();
      await algoliaTransaction({
        jobId: this.cloud.jobId,
        name,
        contractAddress: args.contractAddress,
        chain: this.cloud.chain,
        hash: txSent?.hash,
        status: txSent?.status,
        operation: "mint",
        price,
        sender: sender.toBase58(),
      });
      if (txSent?.status == "pending") {
        console.log(`tx sent: hash: ${txSent?.hash} status: ${txSent?.status}`);
        await algolia({
          ...algoliaData,
          status: "pending",
        });
        await this.cloud.publishTransactionMetadata({
          txId: txSent?.hash,
          metadata: {
            events: [{ type: "mint", name, price, owner: sender.toBase58() }],
            actions: [],
            custom: {},
          },
        });
      } else {
        console.log(
          `tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status}`,
          txSent
        );
        await algolia({
          ...algoliaData,
          status: "failed",
        });
        return `Error sending transaction, ${
          txSent?.hash ? "hash: " + txSent?.hash : ""
        } ${txSent?.status ? "status: " + txSent?.status : ""}
        ${txSent?.errors[0] ? "error: " + txSent?.errors[0] : ""}`;
      }
      return (
        txSent?.hash ??
        `Error sending transaction, ${
          txSent?.hash ? "hash: " + txSent?.hash : ""
        } ${txSent?.status ? "status: " + txSent?.status : ""}
      ${txSent?.errors[0] ? "error: " + txSent?.errors[0] : ""}`
      );
    } catch (error) {
      console.error("Error sending transaction", error);
      if (algoliaData)
        await algolia({
          ...algoliaData,
          status: "failed",
        });
      return "Error sending transaction";
    }
  }

  private async prepare(args: {
    contractAddress: string;
    transactions: string[];
  }): Promise<string> {
    if (args.transactions.length === 0) {
      return "No transactions to send";
    }
    let algoliaData: any;

    interface ProofOfNFT {
      key: string;
      value: string;
      isPublic: boolean;
    }

    interface SimpleImageData {
      filename: string;
      size: number;
      mimeType: string;
      sha3_512: string;
      storage: string;
    }
    interface SimpleMintNFT {
      contractAddress: string;
      chain: string;
      name: string;
      description: string;
      collection: string;
      price: number;
      owner: string;
      image: SimpleImageData;
      keys: ProofOfNFT[];
    }
    try {
      const chain = this.cloud.chain as blockchain;
      console.log("chain:", chain);
      await initBlockchain(chain);

      const nftData: SimpleMintNFT = JSON.parse(
        args.transactions[0]
      ) as SimpleMintNFT;
      const {
        contractAddress,
        owner,
        price,
        name,
        description,
        collection,
        image,
        keys,
      } = nftData;

      const nftPrivateKey = PrivateKey.random();
      const address = nftPrivateKey.toPublicKey();
      const net = await initBlockchain(chain);
      const sender = PublicKey.fromBase58(owner);
      const pinataJWT = PINATA_JWT;
      const arweaveKey = undefined;
      const jwt = MINANFT_JWT;
      if (jwt === undefined) {
        console.error("JWT is undefined");
        return "Error: JWT is undefined";
      }

      if (pinataJWT === undefined) {
        console.error("pinataJWT is undefined");
        return "Error: pinataJWT is undefined";
      }

      const minanft = new api(jwt);
      const reservedPromise = minanft.reserveName({
        name,
        publicKey: owner,
        chain: "devnet",
        contract: contractAddress,
        version: "v2",
        developer: "DFST",
        repo: "web-mint-example",
      });

      const nft = new RollupNFT({
        name,
        address,
        external_url: net.network.explorerAccountUrl + address.toBase58(),
      });

      if (collection !== undefined && collection !== "")
        nft.update({ key: `collection`, value: collection });

      if (description !== undefined && description !== "")
        nft.updateText({
          key: `description`,
          text: description,
        });

      for (const item of keys) {
        const { key, value, isPublic } = item;
        nft.update({ key, value, isPrivate: isPublic === false });
      }

      console.time("reserved name");
      const reserved = await reservedPromise;
      console.timeEnd("reserved name");

      console.log("Reserved", reserved);
      if (
        reserved === undefined ||
        reserved.isReserved !== true ||
        reserved.signature === undefined ||
        reserved.signature === "" ||
        reserved.price === undefined ||
        reserved.expiry === undefined ||
        (reserved.price as any)?.price === undefined
      ) {
        console.error("Name is not reserved");
        return "Error: Name is not reserved" + reserved?.reason
          ? ": " + reserved.reason
          : "";
      }

      const signature = Signature.fromBase58(reserved.signature);
      if (signature === undefined) {
        console.error("Signature is undefined");
        return "Error: Signature is undefined";
      }

      const expiry = UInt32.from(reserved.expiry);

      const imageData = new FileData({
        fileRoot: Field(0),
        height: 0,
        filename: image.filename.substring(0, 30),
        size: image.size,
        mimeType: image.mimeType.substring(0, 30),
        sha3_512: image.sha3_512,
        storage: image.storage,
      });

      nft.updateFileData({ key: `image`, type: "image", data: imageData });

      const commitPromise = nft.prepareCommitData({ pinataJWT });

      const zkAppAddress = PublicKey.fromBase58(MINANFT_NAME_SERVICE_V2);
      const zkApp = new NameContractV2(zkAppAddress);
      const fee = Number((await MinaNFT.fee()).toBigInt());
      const memo = `mint NFT @${name}`.substring(0, 30);
      await fetchMinaAccount({ publicKey: sender });
      await fetchMinaAccount({ publicKey: zkAppAddress });
      console.time("prepared commit data");
      await commitPromise;
      console.timeEnd("prepared commit data");

      if (nft.storage === undefined) throw new Error("Storage is undefined");
      if (nft.metadataRoot === undefined)
        throw new Error("Metadata is undefined");
      const json = JSON.stringify(
        nft.toJSON({
          includePrivateData: true,
        }),
        null,
        2
      );
      console.log("json", json);

      const verificationKey: VerificationKey = {
        hash: Field.fromJSON(VERIFICATION_KEY_V2_JSON.devnet.hash),
        data: VERIFICATION_KEY_V2_JSON.devnet.data,
      };
      const mintParams: MintParams = {
        name: MinaNFT.stringToField(nft.name!),
        address,
        price: UInt64.from(BigInt(price * 1e9)),
        fee: UInt64.from(
          BigInt((reserved.price as any)?.price * 1_000_000_000)
        ),
        owner: sender,
        feeMaster: wallet,
        verificationKey,
        signature,
        metadataParams: {
          metadata: nft.metadataRoot,
          storage: nft.storage!,
        },
        expiry,
      };
      const tx = await Mina.transaction({ sender, fee, memo }, async () => {
        //AccountUpdate.fundNewAccount(sender!);
        await zkApp.mint(mintParams);
      });

      tx.sign([nftPrivateKey]);
      const serializedTransaction = serializeTransaction(tx);
      const transaction = tx.toJSON();
      return JSON.stringify({
        transaction,
        serializedTransaction,
        mintParams: serializeFields(MintParams.toFields(mintParams)),
        fee,
        memo,
      });
    } catch (error) {
      console.error("Error preparing transaction", error);
      return "Error preparing transaction";
    }
  }
}

export async function zkcloudworker(cloud: Cloud): Promise<zkCloudWorker> {
  return new MintWorker(cloud);
}
