use anchor_lang::prelude::*;
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = vault.authority == authority.key() @ VaultError::WrongAuthority)]
    pub authority: Signer<'info>,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    // A commented-out throw. The index must not offer this line as a candidate:
    // require!(amount > 0, VaultError::VaultLocked);
    require!(!ctx.accounts.vault.locked, VaultError::VaultLocked);
    require_gt!(amount, 0, VaultError::AmountTooSmall);

    let remaining = ctx
        .accounts
        .vault
        .balance
        .checked_sub(amount)
        .ok_or(VaultError::AmountTooSmall)?;

    check_limit(remaining)?;
    ctx.accounts.vault.balance = remaining;
    Ok(())
}

/// Reached only by a call, which a lexical index cannot follow. Its site must
/// still be reported, ranked below anything inside the handler body.
fn check_limit(remaining: u64) -> Result<()> {
    if remaining > 1_000_000 {
        return Err(VaultError::LimitExceeded.into());
    }
    Ok(())
}
