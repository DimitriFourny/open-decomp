export const ENCODINGS = [
    {
        "instructionId": "BFC_BFM",
        "encodingId": "BFC_BFM_32M_bitfield",
        "mnemonic": "BFM",
        "className": "Leaving other bits unchanged",
        "fileName": "bfc_bfm.xml",
        "mask": 4290773984,
        "value": 855639008,
        "bitCount": 15,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "immr",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "imms",
                "lsb": 10,
                "width": 6
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_ASMv8p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "N",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "N",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "immr",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "imms",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "BFM_32M_bitfield",
        "canonicalFileName": "bfm.xml",
        "operandFamilyId": "bitfield-immediate"
    },
    {
        "instructionId": "BFC_BFM",
        "encodingId": "BFC_BFM_64M_bitfield",
        "mnemonic": "BFM",
        "className": "Leaving other bits unchanged",
        "fileName": "bfc_bfm.xml",
        "mask": 4290773984,
        "value": 3007316960,
        "bitCount": 15,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "immr",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "imms",
                "lsb": 10,
                "width": 6
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_ASMv8p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "N",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "N",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "immr",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "imms",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "BFM_64M_bitfield",
        "canonicalFileName": "bfm.xml",
        "operandFamilyId": "bitfield-immediate"
    }
];
