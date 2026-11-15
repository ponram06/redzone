// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EscrowVault} from "../src/EscrowVault.sol";

/// @notice Deploys EscrowVault and (optionally) locks a first bounty.
///         The sender needs a registered ML-DSA-87 key and a live EVM window first
///         (`npm run window status` / `npm run window open`, see README).
/// Env:
///   PRIVATE_KEY         deployer = vault admin (must have a registered PQ key)
///   REFEREE_PUBKEY      0x-hex ML-DSA-87 public key of the referee service
///   INITIAL_BOUNTY_WEI  optional, a first bounty locked by the deployer
///   ROBOT_ID            optional, label for that bounty (default "redzone-demo-robot")
contract DeployVault is Script {
    function run() external returns (EscrowVault vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        bytes memory refereePubkey = vm.envBytes("REFEREE_PUBKEY");
        uint256 bounty = vm.envOr("INITIAL_BOUNTY_WEI", uint256(0));
        string memory robot = vm.envOr("ROBOT_ID", string("redzone-demo-robot"));

        vm.startBroadcast(deployerKey);
        vault = new EscrowVault(refereePubkey);
        if (bounty > 0) {
            uint256 id = vault.depositBounty{value: bounty}(keccak256(bytes(robot)));
            console.log("Bounty id", id);
        }
        vm.stopBroadcast();

        console.log("EscrowVault deployed at", address(vault));
        console.log("Admin", vault.admin());
    }
}
