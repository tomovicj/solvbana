use anchor_lang::prelude::*;

/// The accounts struct is deliberately *not* named after the handler. Anchor's
/// convention is `claim` taking `Context<Claim>`, and following that convention
/// would be a guess; the link is written in the signature and is read from there.
#[derive(Accounts)]
#[instruction(round: u64)]
pub struct ClaimAccounts<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, Vault>,

    #[account(
        seeds = [b"creator_vault", vault.creator.as_ref(), &round.to_le_bytes()],
        bump,
    )]
    pub creator_vault_authority: UncheckedAccount<'info>,

    /// No attributes at all: an `AccountNotInitialized` here comes from the
    /// declared type rather than from any constraint expression.
    pub receipt: Account<'info, Receipt>,

    pub authority: Signer<'info>,
}

pub fn claim(ctx: Context<'_, '_, '_, 'info, ClaimAccounts<'info>>, round: u64) -> Result<()> {
    // Deliberately raises nothing. Every check that can fail here is declared
    // above as an attribute, which is exactly the shape the throw-site index
    // cannot see and the declaration lookup exists for.
    Ok(())
}
