// Verbatim copy of upstream's unit tests (src/lib.rs, `mod tests`) at the recipe snapshot, kept
// under a protected path so the same assertions always run; `super::` paths name the crate
// (recipe overlay, protected).
mod tests {
    use std::io::prelude::Write;

    use md5::Context;

    #[test]
    fn compute() {
        let inputs = [
            "",
            "a",
            "abc",
            "message digest",
            "abcdefghijklmnopqrstuvwxyz",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
            "0123456789012345678901234567890123456789012345678901234567890123",
            "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
        ];
        let outputs = [
            "d41d8cd98f00b204e9800998ecf8427e",
            "0cc175b9c0f1b6a831c399e269772661",
            "900150983cd24fb0d6963f7d28e17f72",
            "f96b697d7cb7938d525a2f31aaf161d0",
            "c3fcd3d76192e4007dfb496cca67e13b",
            "d174ab98d277d9f5a5611c2c9f419d9f",
            "7f7bfd348709deeaace19e3f535f8c54",
            "57edf4a22be3c955ac49da2e2107b67a",
        ];
        for (input, &output) in inputs.iter().zip(outputs.iter()) {
            let digest = md5::compute(input);
            assert_eq!(format!("{digest:x}"), output);

            let mut context = Context::new();
            context.consume(input);
            let digest = context.finalize();
            assert_eq!(format!("{digest:x}"), output);
        }
    }

    #[test]
    fn consume() {
        for len in [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1024] {
            let data: Vec<_> = (0..len).map(|i| (i % 251) as u8).collect();
            let expected = md5::compute(&data);
            for chunk_size in [1, 7, 63, 64, 65, 128] {
                let mut context = Context::new();
                for chunk in data.chunks(chunk_size) {
                    context.consume(chunk);
                }
                assert_eq!(context.finalize(), expected);
            }
        }
    }

    #[test]
    fn index() {
        let mut digest = md5::compute(b"abc");
        assert_eq!(digest[0], 0x90);
        assert_eq!(&digest[0], &0x90);
        assert_eq!(&mut digest[0], &mut 0x90);
    }

    #[test]
    fn write_29() {
        let data = vec![0; 8 * 1024 * 1024];
        let mut context = Context::new();
        for _ in 0..64 {
            context.write(&data).unwrap();
        }
        assert_eq!(
            format!("{:x}", context.finalize()),
            "aa559b4e3523a6c931f08f4df52d58f2",
        );
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn write_32() {
        let data = vec![0; std::u32::MAX as usize + 1];
        let mut context = Context::new();
        context.write(&data).unwrap();
        assert_eq!(
            format!("{:x}", context.finalize()),
            "c9a5a6878d97b48cc965c1e41859f034",
        );
    }
}
