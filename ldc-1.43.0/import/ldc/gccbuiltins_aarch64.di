module ldc.gccbuiltins_aarch64; 

import core.simd;

nothrow @nogc:

pragma(LDC_intrinsic, "llvm.aarch64.chkfeat")
    long __builtin_arm_chkfeat(long) pure @safe;

pragma(LDC_intrinsic, "llvm.aarch64.dmb")
    void __builtin_arm_dmb(int);

pragma(LDC_intrinsic, "llvm.aarch64.dsb")
    void __builtin_arm_dsb(int);

pragma(LDC_intrinsic, "llvm.aarch64.gcspopm")
    long __builtin_arm_gcspopm(long);

pragma(LDC_intrinsic, "llvm.aarch64.gcsss")
    void* __builtin_arm_gcsss(void*);

pragma(LDC_intrinsic, "llvm.aarch64.isb")
    void __builtin_arm_isb(int);

pragma(LDC_intrinsic, "llvm.aarch64.prefetch")
    void __builtin_arm_prefetch(void*, int, int, int, int);

pragma(LDC_intrinsic, "llvm.aarch64.range.prefetch")
    void __builtin_arm_range_prefetch(void*, int, int, long);

pragma(LDC_intrinsic, "llvm.aarch64.sme.in.streaming.mode")
    bool __builtin_arm_in_streaming_mode() pure @safe;

pragma(LDC_intrinsic, "llvm.aarch64.sve.setffr")
    void __builtin_sve_svsetffr();

