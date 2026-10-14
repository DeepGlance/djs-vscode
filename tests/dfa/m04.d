void f(int n)
{
    int* a; int* b; int* c; int* d;
    float fa; float fb;
    bool z1; bool z2; bool z3;
    float r;
    int v;
    switch (n)
    {
        case 1:
            v = *a;
            assert(z1);
            goto case;
        case 2:
            v = *b;
            r = fa * 2;
            break;
        case 3:
            assert(z2);
            r = fb * 2;
            v = *c;
            break;
        default:
            v = *d;
            assert(z3);
    }
}
