// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RobotRegistry} from "../src/RobotRegistry.sol";

/// @notice Deploys RobotRegistry (run DeployVault.s.sol for the EscrowVault).
///         Two separate scripts keep each deploy within one 5-transaction EVM window.
/// Env:
///   PRIVATE_KEY     deployer = admin (must have a registered PQ key and an open window)
///   REFEREE_PUBKEY  0x-hex ML-DSA-87 public key of the referee service
contract DeployRedZone is Script {
    function run() external returns (RobotRegistry registry) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        bytes memory refereePubkey = vm.envBytes("REFEREE_PUBKEY");

        vm.startBroadcast(deployerKey);
        registry = new RobotRegistry(refereePubkey);
        vm.stopBroadcast();

        console.log("RobotRegistry deployed at", address(registry));
    }
}
