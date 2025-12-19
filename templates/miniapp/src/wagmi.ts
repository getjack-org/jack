import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { http, createConfig } from "wagmi";
import { base, mainnet, optimism } from "wagmi/chains";

export const config = createConfig({
	chains: [base, mainnet, optimism],
	connectors: [farcasterMiniApp()],
	transports: {
		[base.id]: http(),
		[mainnet.id]: http(),
		[optimism.id]: http(),
	},
});
