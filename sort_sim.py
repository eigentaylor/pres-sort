#!/usr/bin/env python3
"""
sort_sim.py

Simulate interactive sorting using the historical ranking from historical_ranking.csv
and measure the number of pairwise comparisons (choices) required by several
comparison-based sorting algorithms when they are given the same initial ordering
method used by the app (a seeded shuffle using xorshift32).

Algorithms included: binary insertion, merge sort, randomized quicksort, heap sort

Run: python sort_sim.py
"""
import csv
import math
import statistics
import random
from collections import namedtuple
from copy import deepcopy

CSV_PATH = 'historical_ranking.csv'
ATTEMPTS = 100

President = namedtuple('President', ['id', 'name', 'rank'])

def normalize_name(name):
    return name.lower().replace('.', '').replace(' ', '_').replace("'", '').replace('-', '_')

def load_presidents(csv_path=CSV_PATH):
    rows = []
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            idx = int(r['index'])
            name = r['name'].strip()
            pid = normalize_name(name)
            rows.append(President(id=pid, name=name, rank=idx))
    return rows

# xorshift32 seeded RNG matching the app.js implementation closely
class XorShift32:
    def __init__(self, seed=1):
        self.state = seed & 0xffffffff
        if self.state == 0:
            self.state = 1

    def rand(self):
        x = self.state
        x ^= (x << 13) & 0xffffffff
        x ^= (x >> 17) & 0xffffffff
        x ^= (x << 5) & 0xffffffff
        self.state = x & 0xffffffff
        return (self.state & 0xffffffff) / 0x100000000

def seeded_shuffle(items, seed):
    # replicate behaviour: 2..4 passes of Fisher-Yates with xorshift32
    rng = XorShift32(seed)
    a = list(items)
    passes = 2 + int(math.floor(rng.rand() * 3))
    for _ in range(passes):
        for i in range(len(a) - 1, 0, -1):
            j = int(math.floor(rng.rand() * (i + 1)))
            a[i], a[j] = a[j], a[i]
    return a

# Comparison wrapper that counts the number of comparisons
class Comparator:
    def __init__(self, rank_map):
        self.rank_map = rank_map
        self.count = 0

    def cmp(self, a, b):
        # returns negative if a<b (a should come before b), positive if a>b
        self.count += 1
        ra = self.rank_map[a.id]
        rb = self.rank_map[b.id]
        # lower rank number is better (1 is best)
        return (ra - rb)

# Sorting algorithms that use a cmp function returning negative/zero/positive
def binary_insertion_sort(arr, cmp_func):
    out = []
    for x in arr:
        # binary search for insertion index
        lo, hi = 0, len(out)
        while lo < hi:
            mid = (lo + hi) // 2
            if cmp_func(out[mid], x) <= 0:
                # out[mid] <= x -> insert after mid
                lo = mid + 1
            else:
                hi = mid
        out.insert(lo, x)
    return out

def merge_sort(arr, cmp_func):
    n = len(arr)
    if n <= 1:
        return list(arr)
    mid = n // 2
    L = merge_sort(arr[:mid], cmp_func)
    R = merge_sort(arr[mid:], cmp_func)
    # merge
    i = j = 0
    out = []
    while i < len(L) and j < len(R):
        if cmp_func(L[i], R[j]) <= 0:
            out.append(L[i]); i += 1
        else:
            out.append(R[j]); j += 1
    out.extend(L[i:]); out.extend(R[j:])
    return out

def quicksort(arr, cmp_func, rng=random.Random()):
    a = list(arr)
    def _qs(lo, hi):
        if lo >= hi: return
        pivot_index = rng.randint(lo, hi)
        pivot = a[pivot_index]
        # move pivot to end
        a[pivot_index], a[hi] = a[hi], a[pivot_index]
        store = lo
        for i in range(lo, hi):
            if cmp_func(a[i], pivot) <= 0:
                a[i], a[store] = a[store], a[i]
                store += 1
        a[store], a[hi] = a[hi], a[store]
        _qs(lo, store - 1)
        _qs(store + 1, hi)
    _qs(0, len(a) - 1)
    return a

def heap_sort(arr, cmp_func):
    a = list(arr)
    n = len(a)
    def sift_down(start, end):
        root = start
        while True:
            child = 2 * root + 1
            if child > end: break
            # pick the child to compare
            if child + 1 <= end and cmp_func(a[child], a[child+1]) > 0:
                child += 1
            if cmp_func(a[root], a[child]) > 0:
                a[root], a[child] = a[child], a[root]
                root = child
            else:
                break
    # build heap
    for start in range((n - 2)//2, -1, -1):
        sift_down(start, n - 1)
    # extract
    for end in range(n - 1, 0, -1):
        a[0], a[end] = a[end], a[0]
        sift_down(0, end - 1)
    # our procedure builds a min-heap and produces a descending array; reverse to get ascending
    return a[::-1]

def run_experiment(presidents, attempts=ATTEMPTS):
    # baseline sorted by true rank (ascending: best first)
    baseline = sorted(presidents, key=lambda p: p.rank)
    rank_map = {p.id: p.rank for p in presidents}

    algos = [
        ('binary_insertion', binary_insertion_sort),
        ('merge_sort', merge_sort),
        ('quicksort', quicksort),
        ('heap_sort', heap_sort),
    ]

    results = {name: [] for name, _ in algos}

    base_seed = 1337
    for attempt in range(attempts):
        seed = base_seed + attempt
        init_order = seeded_shuffle(presidents, seed)
        for name, fn in algos:
            comp = Comparator(rank_map)
            # use a local RNG for deterministic quicksort per seed
            rng = random.Random(seed ^ (hash(name) & 0xffffffff))
            if name == 'quicksort':
                sorted_list = fn(init_order, comp.cmp, rng)
            else:
                sorted_list = fn(init_order, comp.cmp)
            # verify correctness
            ok = [p.id for p in sorted_list] == [p.id for p in baseline]
            if not ok:
                raise RuntimeError(f"Algorithm {name} produced incorrect result on attempt {attempt}")
            results[name].append(comp.count)

    # Summarize
    summary = {}
    for name in results:
        arr = results[name]
        summary[name] = {
            'attempts': len(arr),
            'avg': statistics.mean(arr),
            'median': statistics.median(arr),
            'min': min(arr),
            'max': max(arr),
            'stdev': statistics.pstdev(arr) if len(arr) > 1 else 0.0,
        }
    return summary

def print_summary(summary):
    print('\nSort comparison summary (number of pairwise comparisons)')
    print('Algorithm            attempts   avg     median    min    max    stdev')
    for name, s in summary.items():
        print(f"{name:20} {s['attempts']:8d}   {s['avg']:7.2f}   {s['median']:7.1f}   {s['min']:5d}   {s['max']:5d}   {s['stdev']:6.2f}")

def main():
    presidents = load_presidents()
    print(f'Loaded {len(presidents)} presidents from {CSV_PATH}')
    summary = run_experiment(presidents, attempts=ATTEMPTS)
    print_summary(summary)

if __name__ == '__main__':
    main()
