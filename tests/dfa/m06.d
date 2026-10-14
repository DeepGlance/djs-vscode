struct S { int* p; float f; int x; }
void f()
{
    S s1; S s2;
    int* a; int* b;
    S* sp = null;
    int v1 = *s1.p;
    float r = s2.f * 2;
    int v2 = *sp.p;
    int v3 = *a;
    int v4 = *b;
    S* q = new S;
    q = null;
    int v5 = q.x;
}
