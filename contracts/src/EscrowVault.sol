// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PQGuard} from "./PQGuard.sol";
import {PQAdmin} from "./PQAdmin.sol";

/// @title EscrowVault
/// @notice Holds RedZone bounties in native QOR. Every action that moves money or changes
///         who can move money is authorised by an ML-DSA-87 signature verified on chain:
///           - claimBounty    : the referee's ML-DSA verdict (breach confirmed, pays the bound claimer)
///           - withdrawBounty : the bounty owner's ML-DSA signature
///           - setReferee / setPaused / transferAdmin : the admin's ML-DSA signature (PQAdmin)
///         msg.sender is never trusted for authorisation. Anyone may relay a signed message,
///         so a leaked or quantum-broken ECDSA key cannot move funds or change settings.
contract EscrowVault is PQAdmin {
    enum Status {
        None,
        Open,
        Claimed,
        Withdrawn
    }

    struct Bounty {
        address owner;
        bytes32 robotId;
        uint128 amount;
        Status status;
    }

    bytes32 public constant CLAIM_TYPEHASH = keccak256("RedZone.Claim(uint256 bountyId,address claimer,bytes32 replayHash,uint256 deadline)");
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("RedZone.Withdraw(uint256 bountyId,address to,uint256 nonce,uint256 deadline)");

    uint256 public nextBountyId = 1;
    uint256 public totalLocked;
    mapping(uint256 => Bounty) public bounties;

    uint256 private _lock = 1;

    event BountyDeposited(uint256 indexed bountyId, bytes32 indexed robotId, address indexed owner, uint256 amount);
    event BountyClaimed(uint256 indexed bountyId, address indexed claimer, bytes32 replayHash, uint256 amount);
    event BountyWithdrawn(uint256 indexed bountyId, address indexed to, uint256 amount);

    error ZeroAmount();
    error AmountTooLarge();
    error BountyNotOpen();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param refereePubkey_ The referee service's ML-DSA-87 public key.
    constructor(bytes memory refereePubkey_) PQAdmin("RedZone.EscrowVault.v1", refereePubkey_) {}

    /// @notice Lock native QOR as a bounty on a robot. The sender becomes the bounty owner and
    ///         must have a registered PQ key, because only that key can withdraw it later.
    function depositBounty(bytes32 robotId) external payable whenNotPaused returns (uint256 bountyId) {
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value > type(uint128).max) revert AmountTooLarge();
        if (!PQGuard.hasPQKey(msg.sender)) revert PQGuard.PQCKeyNotRegistered(msg.sender);

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({owner: msg.sender, robotId: robotId, amount: uint128(msg.value), status: Status.Open});
        totalLocked += msg.value;
        emit BountyDeposited(bountyId, robotId, msg.sender, msg.value);
    }

    /// @notice Pay a bounty to the player who breached the robot.
    /// @dev The referee's ML-DSA verdict binds bountyId, claimer and replayHash, and the payment
    ///      always goes to `claimer`, so whoever relays the transaction cannot redirect funds.
    ///      The bounty closes on success, so a verdict cannot be replayed.
    function claimBounty(
        uint256 bountyId,
        address claimer,
        bytes32 replayHash,
        uint256 deadline,
        bytes calldata refereeSig
    ) external nonReentrant whenNotPaused notExpired(deadline) {
        if (claimer == address(0)) revert ZeroAddress();
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();

        _requireRefereeSig(claimDigest(bountyId, claimer, replayHash, deadline), refereeSig);

        uint256 amount = b.amount;
        b.status = Status.Claimed;
        b.amount = 0;
        totalLocked -= amount;
        emit BountyClaimed(bountyId, claimer, replayHash, amount);
        _send(claimer, amount);
    }

    /// @notice Owner pulls an open bounty back. Needs the owner's ML-DSA signature.
    /// @dev Not blocked by pause, so owners can always recover funds.
    function withdrawBounty(uint256 bountyId, address to, uint256 deadline, bytes calldata ownerSig)
        external
        nonReentrant
        notExpired(deadline)
    {
        if (to == address(0)) revert ZeroAddress();
        Bounty storage b = bounties[bountyId];
        if (b.status != Status.Open) revert BountyNotOpen();
        address owner = b.owner;

        PQGuard.requireAccountSig(owner, withdrawDigest(bountyId, to, nonces[owner], deadline), ownerSig);
        nonces[owner]++;

        uint256 amount = b.amount;
        b.status = Status.Withdrawn;
        b.amount = 0;
        totalLocked -= amount;
        emit BountyWithdrawn(bountyId, to, amount);
        _send(to, amount);
    }

    function claimDigest(uint256 bountyId, address claimer, bytes32 replayHash, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(CLAIM_TYPEHASH, bountyId, claimer, replayHash, deadline));
    }

    function withdrawDigest(uint256 bountyId, address to, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(abi.encode(WITHDRAW_TYPEHASH, bountyId, to, nonce, deadline));
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Plain transfers are rejected so every QOR in the vault belongs to a tracked bounty.
    receive() external payable {
        revert();
    }
}
