export const ENCODINGS = [
    {
        "instructionId": "SQRDMLAH_advsimd_elt",
        "encodingId": "SQRDMLAH_asisdelem_R",
        "mnemonic": "SQRDMLAH",
        "className": "Scalar",
        "fileName": "sqrdmlah_advsimd_elt.xml",
        "mask": 4278252544,
        "value": 2130759680,
        "bitCount": 13,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "S",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "H",
                "lsb": 11,
                "width": 1
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
            "FEAT_RDM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_RDM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-saturating-rounding-doubling-multiply"
    },
    {
        "instructionId": "SQRDMLAH_advsimd_elt",
        "encodingId": "SQRDMLAH_asimdelem_R",
        "mnemonic": "SQRDMLAH",
        "className": "Vector",
        "fileName": "sqrdmlah_advsimd_elt.xml",
        "mask": 3204510720,
        "value": 788582400,
        "bitCount": 12,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "S",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "H",
                "lsb": 11,
                "width": 1
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
            "FEAT_RDM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_RDM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-saturating-rounding-doubling-multiply"
    }
];
