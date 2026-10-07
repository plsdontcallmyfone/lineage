// Lineage overlay (protected): a verbatim copy of the upstream unit tests from src/lib.rs
// (MIT, debris/base58). Upstream keeps its tests inside src/lib.rs, which patches may edit, so
// this copy keeps the same assertions under a protected path.
extern crate base58;
use base58::{ToBase58, FromBase58};


	#[test]
	fn test_from_base58_basic() {
		assert_eq!("".from_base58().unwrap(), b"");
		assert_eq!("Z".from_base58().unwrap(), &[32]);
		assert_eq!("n".from_base58().unwrap(), &[45]);
		assert_eq!("q".from_base58().unwrap(), &[48]);
		assert_eq!("r".from_base58().unwrap(), &[49]);
		assert_eq!("z".from_base58().unwrap(), &[57]);
		assert_eq!("4SU".from_base58().unwrap(), &[45, 49]);
		assert_eq!("4k8".from_base58().unwrap(), &[49, 49]);
		assert_eq!("ZiCa".from_base58().unwrap(), &[97, 98, 99]);
		assert_eq!("3mJr7AoUXx2Wqd".from_base58().unwrap(), b"1234598760");
		assert_eq!("3yxU3u1igY8WkgtjK92fbJQCd4BZiiT1v25f".from_base58().unwrap(), b"abcdefghijklmnopqrstuvwxyz");
	}

	#[test]
	fn test_from_base58_invalid_char() {
		assert!("0".from_base58().is_err());
		assert!("O".from_base58().is_err());
		assert!("I".from_base58().is_err());
		assert!("l".from_base58().is_err());
		assert!("3mJr0".from_base58().is_err());
		assert!("O3yxU".from_base58().is_err());
		assert!("3sNI".from_base58().is_err());
		assert!("4kl8".from_base58().is_err());
		assert!("s!5<".from_base58().is_err());
		assert!("t$@mX<*".from_base58().is_err());
	}

	#[test]
	fn test_from_base58_initial_zeros() {
		assert_eq!("1ZiCa".from_base58().unwrap(), b"\0abc");
		assert_eq!("11ZiCa".from_base58().unwrap(), b"\0\0abc");
		assert_eq!("111ZiCa".from_base58().unwrap(), b"\0\0\0abc");
		assert_eq!("1111ZiCa".from_base58().unwrap(), b"\0\0\0\0abc");
	}

	#[test]
	fn test_to_base58_basic() {
		assert_eq!(b"".to_base58(), "");
		assert_eq!(&[32].to_base58(), "Z");
		assert_eq!(&[45].to_base58(), "n");
		assert_eq!(&[48].to_base58(), "q");
		assert_eq!(&[49].to_base58(), "r");
		assert_eq!(&[57].to_base58(), "z");
		assert_eq!(&[45, 49].to_base58(), "4SU");
		assert_eq!(&[49, 49].to_base58(), "4k8");
		assert_eq!(b"abc".to_base58(), "ZiCa");
		assert_eq!(b"1234598760".to_base58(), "3mJr7AoUXx2Wqd");
		assert_eq!(b"abcdefghijklmnopqrstuvwxyz".to_base58(), "3yxU3u1igY8WkgtjK92fbJQCd4BZiiT1v25f");
	}

	#[test]
	fn test_to_base58_initial_zeros() {
		assert_eq!(b"\0abc".to_base58(), "1ZiCa");
		assert_eq!(b"\0\0abc".to_base58(), "11ZiCa");
		assert_eq!(b"\0\0\0abc".to_base58(), "111ZiCa");
		assert_eq!(b"\0\0\0\0abc".to_base58(), "1111ZiCa");
	}
