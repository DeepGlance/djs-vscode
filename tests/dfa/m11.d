void loops()
{
    int* p1 = new int;
    int* p2 = new int;
    int* p3 = new int;
    int* p4 = new int;
    int* p5 = new int;
    int* p6 = new int;
    int* p7 = new int;
    int* p8 = new int;
    int* p9 = new int;
    int* p10 = new int;
    int* p11 = new int;
    int* p12 = new int;
    foreach (i; 0 .. 2)
    {
        int a1 = *p1;
        int a2 = *p2;
        int a3 = *p3;
        int a4 = *p4;
        int a5 = *p5;
        int a6 = *p6;
        int a7 = *p7;
        int a8 = *p8;
        int a9 = *p9;
        int a10 = *p10;
        int a11 = *p11;
        int a12 = *p12;
        p7 = null;
        p3 = null;
        p11 = null;
        p1 = null;
        p9 = null;
        p5 = null;
        p12 = null;
        p2 = null;
        p10 = null;
        p4 = null;
        p8 = null;
        p6 = null;
    }
}
