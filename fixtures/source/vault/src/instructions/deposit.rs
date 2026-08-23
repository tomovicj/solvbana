use anchor_lang::prelude::*;
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount >= 1_000, VaultError::AmountTooSmall);
    ctx.accounts.vault.balance += amount;
    Ok(())
}
