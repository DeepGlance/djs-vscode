void f(bool c)
{
    float a; float b; float d; float e;
    int* q1; int* q2; int* q3; int* q4; int* q5; int* q6;
    foreach (i; 0 .. 3)
    {
        float x;
        float y = x * 2;
        {
            int* z;
            int w = *z;
            float u;
            float t = u + a;
        }
        float bb = b * 3;
    }
    int k1 = *q1;
    int k2 = *q2;
    float dd = d * e;
    int k3 = *q6;
    int k4 = *q3;
    bool never;
    assert(never);
    assert(q4 !is null);
}
