void loops()
{
    int* p1 = new int;
    int* p2 = new int;
    int* p3 = new int;
    foreach (i; 0 .. 2)
    {
        int a = *p1;
        p1 = null;
        foreach (j; 0 .. 2)
        {
            int b = *p2;
            p2 = null;
            int c = *p3;
            p3 = null;
        }
    }
    float x;
    while (true)
    {
        float y = x + 1;
        break;
    }
}
