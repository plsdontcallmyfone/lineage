//! cu-tally: a tiny Solana program that keeps running statistics in one state account.
//!
//! Instructions (first byte of instruction data is the tag):
//! - 0 `Record`: the rest is a list of little-endian u64 values; updates count, sum, max, min.
//! - 1 `Digest`: CRC-32 (IEEE) of the rest; stored in the state and returned as return data.
//! - 2 `Sort`: the rest is a list of little-endian u32 values (at most 64); the sorted list is
//!   written into the state and its median (lower middle) is returned as return data.
//!
//! Accounts: `[0]` the state account, owned by this program, writable, at least STATE_LEN bytes.

use pinocchio::program_error::ProgramError;

pub const STATE_LEN: usize = 64 + 4 * MAX_SORT;
pub const MAX_SORT: usize = 64;

const OFF_COUNT: usize = 0;
const OFF_SUM: usize = 8;
const OFF_MAX: usize = 16;
const OFF_MIN: usize = 24;
const OFF_CRC: usize = 32;
const OFF_MEDIAN: usize = 36;
const OFF_SORTED_LEN: usize = 40;
const OFF_SORTED: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stats {
    pub count: u64,
    pub sum: u64,
    pub max: u64,
    pub min: u64,
}

fn read_u64(buf: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    for i in 0..8 {
        b[i] = buf[off + i];
    }
    u64::from_le_bytes(b)
}

fn write_u64(buf: &mut [u8], off: usize, v: u64) {
    let b = v.to_le_bytes();
    for i in 0..8 {
        buf[off + i] = b[i];
    }
}

fn read_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn write_u32(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

impl Stats {
    pub fn load(state: &[u8]) -> Stats {
        Stats {
            count: read_u64(state, OFF_COUNT),
            sum: read_u64(state, OFF_SUM),
            max: read_u64(state, OFF_MAX),
            min: read_u64(state, OFF_MIN),
        }
    }

    pub fn store(&self, state: &mut [u8]) {
        write_u64(state, OFF_COUNT, self.count);
        write_u64(state, OFF_SUM, self.sum);
        write_u64(state, OFF_MAX, self.max);
        write_u64(state, OFF_MIN, self.min);
    }
}

/// Folds `values` (little-endian u64s) into the statistics held in `state`.
pub fn record(state: &mut [u8], values: &[u8]) -> Result<(), ProgramError> {
    if state.len() < STATE_LEN || values.len() % 8 != 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let n = values.len() / 8;
    for i in 0..n {
        let v = read_u64(values, i * 8);
        let mut s = Stats::load(state);
        if s.count == 0 {
            s.max = v;
            s.min = v;
        } else {
            if v > s.max {
                s.max = v;
            }
            if v < s.min {
                s.min = v;
            }
        }
        s.count += 1;
        s.sum = s.sum.wrapping_add(v);
        s.store(state);
    }
    Ok(())
}

/// CRC-32 (IEEE 802.3, reflected, init and xorout 0xFFFFFFFF).
pub fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc = (crc >> 8) ^ table[((crc ^ byte as u32) & 0xff) as usize];
    }
    !crc
}

/// Stores the CRC-32 of `data` in `state` and returns it.
pub fn digest(state: &mut [u8], data: &[u8]) -> Result<u32, ProgramError> {
    if state.len() < STATE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let c = crc32(data);
    write_u32(state, OFF_CRC, c);
    Ok(c)
}

/// Sorts `values` (little-endian u32s, at most MAX_SORT) into `state` and returns the median.
pub fn sort(state: &mut [u8], values: &[u8]) -> Result<u32, ProgramError> {
    if state.len() < STATE_LEN || values.len() % 4 != 0 || values.is_empty() || values.len() / 4 > MAX_SORT {
        return Err(ProgramError::InvalidInstructionData);
    }
    let n = values.len() / 4;
    let mut v: Vec<u32> = Vec::new();
    for i in 0..n {
        v.push(read_u32(values, i * 4));
    }
    // bubble sort
    for i in 0..n {
        for j in 0..n - 1 - i {
            if v[j] > v[j + 1] {
                v.swap(j, j + 1);
            }
        }
    }
    for (i, x) in v.iter().enumerate() {
        write_u32(state, OFF_SORTED + 4 * i, *x);
    }
    write_u32(state, OFF_SORTED_LEN, n as u32);
    let median = v[(n - 1) / 2];
    write_u32(state, OFF_MEDIAN, median);
    Ok(median)
}

#[cfg(target_os = "solana")]
mod entry {
    use super::*;
    use pinocchio::{account_info::AccountInfo, entrypoint, program::set_return_data, pubkey::Pubkey, ProgramResult};

    entrypoint!(process_instruction);

    fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        let state = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
        if state.owner() != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !state.is_writable() {
            return Err(ProgramError::InvalidAccountData);
        }
        let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
        let mut buf = state.try_borrow_mut_data()?;
        match tag {
            0 => record(&mut buf, rest),
            1 => {
                let c = digest(&mut buf, rest)?;
                set_return_data(&c.to_le_bytes());
                Ok(())
            }
            2 => {
                let m = sort(&mut buf, rest)?;
                set_return_data(&m.to_le_bytes());
                Ok(())
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
