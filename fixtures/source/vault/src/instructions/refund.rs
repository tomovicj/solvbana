use anchor_lang::prelude::*;

/// Declares a `receipt` field too, so a lookup by field name alone is ambiguous
/// whenever the handler is unknown. Two structs prove nothing about which ran.
#[derive(Accounts)]
pub struct RefundAccounts<'info> {
    pub receipt: Account<'info, Receipt>,
}

pub fn refund(ctx: Context<RefundAccounts>) -> Result<()> {
    Ok(())
}
