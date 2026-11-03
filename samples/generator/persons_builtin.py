"""Faker-free person builder for the second sample set (persons_002.json).

Small invented name/street/city pools + a seeded RNG, so the output depends only on the
Python standard library (Faker output changes between Faker versions). Everything is fictional.
"""
from __future__ import annotations

import random

from .persons import assemble

FIRST = ["Marisol", "Teodor", "Anneliese", "Kwabena", "Priyanka", "Lucian", "Odalys", "Henrik",
         "Saoirse", "Mateus", "Yelena", "Darnell", "Ingrid", "Rashad", "Beatrix", "Ignatius"]
LAST = ["Ferreira", "Lindqvist", "Okafor", "Brandt", "Castellanos", "Ivanova", "Harrow", "Nakamura",
        "Whitlock", "Delacroix", "Abernathy", "Quintero", "Hollis", "Verhoeven", "Mbeki", "Sorensen"]
STREETS = ["Maple", "Cedar", "Lakeview", "Hillcrest", "Orchard", "Willow", "Summit", "Harbor",
           "Meadow", "Juniper", "Foxglove", "Granite"]
SUFFIX = ["Street", "Avenue", "Court", "Lane", "Road", "Drive", "Terrace"]
CITIES = ["Brookhaven", "Easton Vale", "Millford", "Northgate", "Ravenswood", "Stonebridge",
          "Pinehurst", "Westmoor", "Clearwater Bay", "Ashford Hollow"]
STATES = ["CA", "TX", "NY", "OH", "WA", "OR", "MN", "CO", "GA", "MI", "AZ", "NC"]


class BuiltinFake:
    def __init__(self, seed: int):
        self.r = random.Random(seed ^ 0x5EED5)

    def first_name(self):
        return self.r.choice(FIRST)

    def last_name(self):
        return self.r.choice(LAST)

    def street_address(self):
        n = f"{self.r.randint(1, 9999)} {self.r.choice(STREETS)} {self.r.choice(SUFFIX)}"
        return n + (f" Apt {self.r.randint(1, 40)}" if self.r.random() < 0.3 else "")

    def city(self):
        return self.r.choice(CITIES)

    def state_abbr(self):
        return self.r.choice(STATES)

    def postcode(self):
        return f"{self.r.randint(10000, 99999)}"


def build_persons_builtin(seed: int) -> dict:
    return assemble(BuiltinFake(seed), random.Random(seed), seed, ("P003", "P004"),
                    "samples/generator (D1 set 002, built-in pools, no Faker)")
