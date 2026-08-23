use anchor_lang::prelude::*;

/// The same program one revision earlier: `VaultLocked` has not been added yet,
/// so every variant sits one code lower than the deployed build assigns it.
///
/// This is the tree the numbering proof must refuse. Every line it offers would
/// be plausible and wrong, which is the exact failure this project exists to
/// avoid.
#[error_code]
pub enum VaultError {
    /// 6000 in this revision, 6001 in the deployed one.
    AmountTooSmall,
    NeverThrown,
    WrongAuthority,
    LimitExceeded,
}
