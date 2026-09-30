//! Winner selection — a faithful port of the legacy `Auction.getWinners` /
//! `getTopBids` (the jest-tested accounting core), with two deliberate fixes:
//! the attendance tie-break draw picks from the *tied candidates* (audit E3),
//! and the draw is deterministic given a recorded seed.

use crate::event::{PlayerId, Roll};
use crate::state::Bid;

/// Deterministic RNG (splitmix64) so every tie-break is reproducible from the
/// seed recorded in `auction.finalized`.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// A `/random 100`: 1 to 100 inclusive.
    pub fn d100(&mut self) -> u32 {
        self.below(100) as u32 + 1
    }
}

/// Roll-off rounds before a draw settles what is still tied. Each round ties
/// again with odds of at most 1 in 100, so this only makes the loop's end
/// obvious; it is not a rule anyone will meet.
const MAX_ROLL_OFF_ROUNDS: usize = 16;

/// A roll auction's winners, highest roll first, and the roll-off rounds
/// that settled a tie across the cut (empty when there was none).
///
/// Everyone above the cut wins. When more players share the cut roll than
/// slots remain, exactly those players roll again from `rng`, round after
/// round, until the slots fill without a tie. A tie that does not straddle
/// the cut (two 90s for two items) needs no roll-off.
pub fn roll_winners(
    rolls: &[Roll],
    num_items: usize,
    rng: &mut Rng,
) -> (Vec<PlayerId>, Vec<Vec<Roll>>) {
    let mut field = rolls.to_vec();
    // Stable: equal rolls keep the order they were rolled in, so the
    // candidate order (and with it the draw) is fixed by the log.
    field.sort_by_key(|r| std::cmp::Reverse(r.roll));
    let mut open = num_items.max(1);
    let mut rounds: Vec<Vec<Roll>> = Vec::new();
    if field.len() <= open {
        return (field.iter().map(|r| r.player).collect(), rounds);
    }
    let mut winners = Vec::with_capacity(open);
    // Invariant: `field` is sorted high to low and holds more rolls than
    // there are `open` slots, with at least one slot open.
    loop {
        let cut = field[open - 1].roll;
        let above = field.iter().filter(|r| r.roll > cut).count();
        winners.extend(field[..above].iter().map(|r| r.player));
        open -= above;
        let tied: Vec<PlayerId> = field
            .iter()
            .filter(|r| r.roll == cut)
            .map(|r| r.player)
            .collect();
        if tied.len() <= open {
            winners.extend(tied);
            break;
        }
        if rounds.len() == MAX_ROLL_OFF_ROUNDS {
            let mut pool = tied;
            for _ in 0..open {
                winners.push(pool.remove(rng.below(pool.len())));
            }
            break;
        }
        let round: Vec<Roll> = tied
            .into_iter()
            .map(|player| Roll {
                player,
                roll: rng.d100(),
            })
            .collect();
        rounds.push(round.clone());
        field = round;
        field.sort_by_key(|r| std::cmp::Reverse(r.roll));
    }
    (winners, rounds)
}

/// Sort descending by amount, stable (mirrors JS `Array.sort`).
fn sort_by_amount_desc(bids: &mut [Bid]) {
    bids.sort_by_key(|b| std::cmp::Reverse(b.amount));
}

/// Legacy `getTopBids`: pick `n` winners from `bids`, amount first, attendance
/// on ties, seeded random draw when attendance ties too.
fn top_bids(mut bids: Vec<Bid>, n: usize, rng: &mut Rng) -> Vec<Bid> {
    if bids.is_empty() || n == 0 {
        return Vec::new();
    }
    sort_by_amount_desc(&mut bids);
    let min_to_win = if bids.len() > n {
        bids[n - 1].amount
    } else {
        bids[bids.len() - 1].amount
    };
    let mut pool: Vec<Bid> = bids
        .into_iter()
        .filter(|b| b.amount >= min_to_win)
        .collect();

    let mut top: Vec<Bid> = Vec::new();
    while top.len() < n && !pool.is_empty() {
        if pool.len() == 1 || pool[0].amount > pool[1].amount {
            top.push(pool.remove(0));
            continue;
        }
        // Amounts tied: highest attendance among the tied bids wins; a full
        // tie is a recorded random draw from the tied candidates (E3 fix).
        let tied_amount = pool[0].amount;
        let tied: Vec<&Bid> = pool.iter().filter(|b| b.amount == tied_amount).collect();
        let best_att = tied
            .iter()
            .map(|b| b.attendance)
            .fold(f64::NEG_INFINITY, f64::max);
        let candidates: Vec<u64> = tied
            .iter()
            .filter(|b| b.attendance == best_att)
            .map(|b| b.player)
            .collect();
        let chosen_player = if candidates.len() == 1 {
            candidates[0]
        } else {
            candidates[rng.below(candidates.len())]
        };
        let idx = pool
            .iter()
            .position(|b| b.player == chosen_player)
            .expect("chosen candidate came from the pool");
        top.push(pool.remove(idx));
    }
    top
}

/// Legacy `getWinners`: MAIN-qualified bids take priority; ALT bids can be
/// promoted by over-bidding the top MAIN by `over_bid_to_win_main`; remaining
/// item slots fall through to ALT bids.
pub fn winners(
    bids: &[Bid],
    num_winners: usize,
    min_bid_to_lock_for_main: i64,
    over_bid_to_win_main: i64,
    rng: &mut Rng,
) -> Vec<Bid> {
    let highest_main = bids
        .iter()
        .filter(|b| b.for_main)
        .max_by_key(|b| b.amount)
        .map(|b| b.amount);
    let promoted = |b: &Bid| -> bool {
        over_bid_to_win_main > 0
            && highest_main.is_some_and(|h| b.amount >= h + over_bid_to_win_main)
    };
    let main_bids: Vec<Bid> = bids
        .iter()
        .filter(|b| (b.for_main && b.amount >= min_bid_to_lock_for_main) || promoted(b))
        .cloned()
        .collect();
    let alt_bids: Vec<Bid> = bids
        .iter()
        .filter(|b| !main_bids.iter().any(|m| m.player == b.player))
        .cloned()
        .collect();

    let mut result = top_bids(main_bids, num_winners, rng);
    if result.len() < num_winners {
        let fill = top_bids(alt_bids, num_winners, rng);
        result.extend(fill.into_iter().take(num_winners - result.len()));
    }
    result
}
