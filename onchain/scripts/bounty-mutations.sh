#!/bin/sh
# Red then green for the units_bounty attack tests (onchain/tests/tests/open_bounty.rs): each line
# below removes ONE check from a scratch copy of the program, builds it into target/bounty-mut and
# runs the test that covers the check against that build (UNITS_BOUNTY_SO). The test must FAIL on the
# weakened build (red); the suite passes on the real build (green). The program source is not touched.
#   onchain/scripts/bounty-mutations.sh          from the repo root or onchain/ (ONLY=<part of a name> runs those)
set -u
cd "$(dirname "$0")/.."
SRC=programs/units-bounty/src/lib.rs
MUT=target/tmp/units-bounty-mut
OUT=target/bounty-mut
mkdir -p "$MUT/src" "$OUT"
sed 's|path = "../units-registry"|path = "../../../programs/units-registry"|' programs/units-bounty/Cargo.toml > "$MUT/Cargo.toml"
printf '\n[workspace]\n' >> "$MUT/Cargo.toml"
cp Cargo.lock "$MUT/Cargo.lock"
fail=0
n=0
# name | test | the line to remove (a fixed string that must occur exactly once)
while IFS='|' read -r name test line; do
  [ -z "$name" ] && continue
  case "$name" in *"${ONLY:-}"*) ;; *) continue ;; esac
  n=$((n + 1))
  # "from => to" replaces a fragment (every occurrence); anything else is one whole line to remove
  if ! python3 - "$SRC" "$MUT/src/lib.rs" "$line" <<'PY'
import sys
src, out, line = sys.argv[1:4]
s = open(src).read()
if " => " in line:
    a, b = line.split(" => ", 1)
    if a not in s: sys.exit(1)
    s = s.replace(a, b)
else:
    if s.count(line + "\n") != 1: sys.exit(1)
    s = s.replace(line + "\n", "")
open(out, "w").write(s)
PY
  then echo "FAIL $name: the check is not in $SRC as written here"; fail=1; continue; fi
  if ! cargo build-sbf --offline --manifest-path "$MUT/Cargo.toml" --sbf-out-dir "$OUT" >"$OUT/build.log" 2>&1; then
    echo "FAIL $name: the weakened program does not build (see $OUT/build.log)"; fail=1; continue
  fi
  if UNITS_BOUNTY_SO="$OUT/units_bounty.so" cargo test --offline -p units-onchain-tests --test open_bounty "$test" >"$OUT/test.log" 2>&1; then
    echo "FAIL $name: $test passes without the check"; fail=1
  else
    echo "red  $name: $test fails without the check"
  fi
done <<'LIST'
proof against the posted root|a_wrong_winner_is_refused|        require!(leaf::verify_proof(&leaf_h, &args.proof, &ep.record_root), BountyError::BadProof);
required improvement|a_wrong_winner_is_refused|        require!(args.improvement_bps >= b.min_improvement_bps as u64, BountyError::ImprovementTooLow);
metric of the bounty|a_wrong_winner_is_refused|        require!(target_digest(&tj) == b.target_digest, BountyError::WrongTarget);
generation after the open|a_wrong_winner_is_refused|        require!(args.epoch >= b.min_epoch && args.accepted_at >= b.created_at, BountyError::BeforeOpen);
epoch posted by the deadline|a_claim_after_expiry_is_refused_and_the_funder_is_refunded|        require!(ep.posted_at <= b.deadline, BountyError::Late);
first claim before the refund time|a_claim_after_expiry_is_refused_and_the_funder_is_refunded|            require!(now <= b.refund_after, BountyError::Expired);
refund only after expiry|a_claim_after_expiry_is_refused_and_the_funder_is_refunded|        require!(now > a.bounty.refund_after, BountyError::NotExpired);
no early return to the funder|a_posted_reward_cannot_be_taken_back_before_it_expires|        require!(now > a.bounty.refund_after, BountyError::NotExpired);
earlier height only|an_earlier_generation_replaces_a_standing_claim_and_a_replayed_claim_does_not|            require!(args.height < b.win_height, BountyError::NotEarlier);
contest time bounds a replacement|after_the_contest_time_the_standing_claim_cannot_be_replaced|            require!(now < b.contest_until, BountyError::ContestOver);
payout waits for the contest time|a_wallet_with_no_agent_posts|        require!(now >= b.contest_until, BountyError::ContestOpen);
closed bounty takes no claim|a_wallet_with_no_agent_posts|require!(b.status == STATUS_OPEN, BountyError::BountyClosed); => ;
challenge hold|a_claim_waits_for_the_registry_challenge_hold|.map_err(|_| error!(BountyError::Held))?; => .ok();
no refund over a standing claim|a_claim_made_in_time_is_paid_even_after_the_refund_time|        require!(a.bounty.winner == Pubkey::default(), BountyError::ClaimStanding);
pause stops a payout|admin_powers_are_settings|        require!(!c.settings.paused, BountyError::Paused);
unit and metric named|a_bounty_for_a_unit_or_metric|        require!(args.lineage_id != [0u8; 32] && args.target_digest != [0u8; 32], BountyError::InvalidArgs);
refund goes to the funder|a_funder_cannot_take_another_funders_escrow|token::authority = funder,  => 
claim names the author's own vault|a_wrong_winner_is_refused|#[account(seeds = [units_registry::COMPUTE_SEED, args.author.as_ref()], bump, seeds::program = config.launch_program, => #[account(
payout goes to the winner's vault|a_wrong_winner_is_refused|#[account(mut, seeds = [units_registry::COMPUTE_SEED, bounty.winner.as_ref()], bump, seeds::program = config.launch_program, => #[account(mut,
epoch account is the registry's PDA|a_forged_record_root_is_refused|    #[account(seeds = [units_registry::EPOCH_SEED, &args.epoch.to_le_bytes()], bump = registry_epoch.bump, seeds::program = units_registry::ID)]
vault belongs to the bounty|a_funder_cannot_take_another_funders_escrow|    #[account(mut, seeds = [VAULT_SEED, bounty.key().as_ref()], bump = bounty.vault_bump)] => #[account(mut)]
admin only settings|admin_powers_are_settings|has_one = admin @ BountyError::Unauthorized)] => )]
fee vault is the program's|admin_powers_are_settings|    #[account(mut, seeds = [FEE_VAULT_SEED], bump)] => #[account(mut)]
initialize by the upgrade authority|initialize_is_the_upgrade_authority_only|constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ BountyError::Unauthorized)] => )]
LIST
echo "$n checks removed one at a time"
exit $fail
