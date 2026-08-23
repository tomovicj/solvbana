use anchor_lang::prelude::*;

/// Synthetic, not harvested. Hand-written to exercise the throw-site index
/// against every form real Anchor code uses, including the ones that are easy
/// to miss: an `@` in an account attribute, an `ok_or`, and a variant that is
/// declared but never raised.
///
/// The declaration order is load-bearing. Anchor numbers these from 6000, and
/// that numbering is what an uploaded tree uses to prove it describes the
/// program that ran.
#[error_code]
pub enum VaultError {
    /// 6000 — raised in exactly one place, so narrowing finds a single site.
    VaultLocked,
    /// 6001 — raised three times across two handlers.
    AmountTooSmall,
    /// 6002 — declared and never raised anywhere in the tree.
    NeverThrown,
    /// 6003 — raised only from an account constraint attribute.
    WrongAuthority,
    /// 6004 — raised from a helper no handler body lexically contains.
    LimitExceeded,
}
