void f(int n)
{
    int* a; int* b; int* c;
    float fa; float fb;
    bool z1; bool z2; bool z3;
    float ra, rb;
    int va, vb, vc;
    if (n > 3)
        goto L2;
L1:
    va = *a;
    ra = fa * 2;
    assert(z1);
    goto L3;
L2:
    vb = *b;
    assert(z2);
    goto L1;
L3:
    rb = fb + 1;
    vc = *c;
    assert(z3);
}
