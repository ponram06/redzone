// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RobotRegistryV3} from "../src/v3/RobotRegistryV3.sol";
import {EscrowVaultV2} from "../src/v3/EscrowVaultV2.sol";

/// @notice Deploys RobotRegistryV3 and EscrowVaultV2 (2 transactions, one EVM window).
/// Needs:
///   PRIVATE_KEY        deployer = admin (registered ML-DSA-87 key, open EVM window)
///   NATIVE_CHAIN_ID    e.g. qorechain-diana
///   .v3-proofs.json    from `pnpm v3-proofs` (deployer and referee proofs, referee public key)
contract DeployV3 is Script {
    function run() external returns (RobotRegistryV3 registry, EscrowVaultV2 vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        bytes memory chain = bytes(vm.envOr("NATIVE_CHAIN_ID", string("qorechain-diana")));
        string memory j = vm.readFile(".v3-proofs.json");
        require(vm.parseJsonAddress(j, ".deployer") == vm.addr(deployerKey), "proofs were made for another deployer");
        require(vm.parseJsonUint(j, ".chainId") == block.chainid, "proofs were made for another chain");

        vm.startBroadcast(deployerKey);
        registry = new RobotRegistryV3(
            vm.parseJsonBytes(j, ".refereePubkey"),
            chain,
            vm.parseJsonBytes(j, ".registryDeployerProof"),
            vm.parseJsonBytes(j, ".registryRefereeProof")
        );
        vault = new EscrowVaultV2(registry, chain, vm.parseJsonBytes(j, ".vaultDeployerProof"));
        vm.stopBroadcast();

        console.log("RobotRegistryV3:", address(registry));
        console.log("EscrowVaultV2:  ", address(vault));
    }
}
