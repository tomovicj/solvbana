use anchor_lang::prelude::*;
use crate::errors::VaultError;

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require_gt!(amount, 0, VaultError::AmountTooSmall);
    Ok(())
}
