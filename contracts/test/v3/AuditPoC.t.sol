// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// The adversarial audit's three proofs of concept (M-01 stockpiled sybil breach, L-01 ECDSA
// shortcut, L-02 stale withdrawal request) were fixed in the contracts. Their regression tests
// live in RedZoneV3.t.sol: test_Audit3_* and test_NoEcdsaShortcuts.
