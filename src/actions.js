import { utils } from "ethers";
import * as connext from "@connext/client";
import { ColorfulLogger, stringify } from "@connext/utils";
import { getLocalStore } from "@connext/store";
import axios from "axios";

import { getWallet } from "./wallet";

const dotenv = require("dotenv");
dotenv.config();

const nodeUrl = "https://node.spacefold.io/";

export async function initClients(
  tokens,
  onMintSucceeded,
  onTransferSucceeded,
  onWithdrawSucceeded,
  onBalanceRefresh
) {
  const clientsAndBalances = await Promise.all(
    Object.values(tokens).map(async (token) => {
      try {
        console.log(`Creating client for token ${JSON.stringify(token)}`);
        const pk = getWallet(token.chainId).privateKey;
        const client = await connext.connect({
          nodeUrl,
          ethProviderUrl: token.ethProviderUrl,
          signer: getWallet(token.chainId).privateKey,
          loggerService: new ColorfulLogger(
            token.chainId.toString(),
            3,
            false,
            token.chainId
          ),
          store: getLocalStore({
            prefix: `INDRA_CLIENT_${pk.substring(0, 10).toUpperCase()}`,
          }),
          logLevel: 3,
        });
        const freeBalance = await client.getFreeBalance(token.tokenAddress);
        console.log(
          `Created client for token ${JSON.stringify(token)}: ${
            client.publicIdentifier
          } with balance: ${freeBalance[client.signerAddress]}`
        );

        client.requestCollateral(token.tokenAddress);

        const refreshBalances = async (client) => {
          const token = tokens[client.chainId];
          const channel = await client.getFreeBalance(token.tokenAddress);
          onBalanceRefresh(client.chainId, channel[client.signerAddress]);
          return channel[client.signerAddress];
        };

        client.on("CONDITIONAL_TRANSFER_CREATED_EVENT", async (msg) => {
          const updated = await refreshBalances(client);
          console.log("Transfer created, updated balances", updated);
          onMintSucceeded();
        });
        client.on("CONDITIONAL_TRANSFER_UNLOCKED_EVENT", async (msg) => {
          const updated = await refreshBalances(client);
          console.log("Transfer unlocked, updated balances", updated);
          onTransferSucceeded();
        });
        client.on("WITHDRAWAL_CONFIRMED_EVENT", async (msg) => {
          const updated = await refreshBalances(client);
          console.log("Withdrawal completed, updated balances", updated);
          onWithdrawSucceeded();
        });

        return { client, freeBalance };
      } catch (e) {
        throw new Error(
          `Failed to create client on ${token.chainId}. Error: ${e.message}`
        );
      }
    })
  );
  const clients = clientsAndBalances.reduce((c, entry) => {
    if (entry) {
      c[entry.client.chainId] = entry.client;
    }
    return c;
  }, {});
  const balances = clientsAndBalances.reduce((b, entry) => {
    if (entry) {
      b[entry.client.chainId] = utils.formatEther(
        entry.freeBalance[entry.client.signerAddress]
      );
    }
    return b;
  }, {});
  return { clients, balances };
}

export async function mint(mintToken, clients, tweetUrl) {
  const assetId = mintToken.tokenAddress;
  const client = clients[mintToken.chainId];
  if (!client) {
    throw new Error(`Failed to find client for ${mintToken.chainId}`);
  }
  const faucetUrl = `${process.env.REACT_APP_FAUCET_URL}/faucet`;
  const faucetData = {
    assetId,
    recipient: client.publicIdentifier,
    tweet: tweetUrl,
    chainId: mintToken.chainId,
  };
  try {
    console.log(
      `Making faucet request to ${faucetUrl}: ${stringify(faucetData, true, 0)}`
    );
    const res = await axios.post(faucetUrl, faucetData);
    console.log(`Faucet response: ${JSON.stringify(res)}`);
  } catch (e) {
    throw new Error(
      `Error minting tokens: ${
        e.response ? JSON.stringify(e.response.data || {}) : e.message
      }`
    );
  }
}

export async function transfer(fromToken, toToken, clients, balances) {
  const fromClient = clients[fromToken.chainId];
  const toClient = clients[toToken.chainId];

  const params = {
    assetId: fromToken.tokenAddress,
    amount: utils.parseEther(balances[fromToken.chainId]),
    recipient: toClient.publicIdentifier,
    meta: {
      receiverAssetId: toToken.tokenAddress,
      receiverChainId: toToken.chainId,
    },
  };
  console.log(`Transferring with params ${stringify(params, true, 0)}`);
  const res = await fromClient.transfer(params);
  console.log(`Transfer complete: ${stringify(res, true, 0)}`);
}

export async function send(sendToken, sendAddress, clients) {
  const sendClient = clients[sendToken.chainId];
  try {
    const withdrawParams = {
      amount: utils.parseEther(sendToken.balance),
      assetId: sendToken.tokenAddress,
      recipient: sendAddress,
    };
    console.log(`Sending tokens: ${JSON.stringify(withdrawParams)}`);
    const res = await sendClient.withdraw(withdrawParams);
    console.log(`Withdraw response: ${JSON.stringify(res)}`);
    return res.transaction.hash;
  } catch (e) {
    throw new Error(`Error sending tokens: ${e.stack}`);
  }
}
