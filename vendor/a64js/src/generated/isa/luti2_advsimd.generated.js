export const ENCODINGS = [
    {
        "instructionId": "LUTI2_advsimd",
        "encodingId": "LUTI2_asimdtbl_L5",
        "mnemonic": "LUTI2",
        "className": "Advanced SIMD",
        "fileName": "luti2_advsimd.xml",
        "mask": 4292910080,
        "value": 1317015552,
        "bitCount": 15,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "op2",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "len",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 12,
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
            "FEAT_AdvSIMD && FEAT_LUT"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LUT",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "op2",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "op",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-fp8-luti"
    },
    {
        "instructionId": "LUTI2_advsimd",
        "encodingId": "LUTI2_asimdtbl_L6",
        "mnemonic": "LUTI2",
        "className": "Advanced SIMD",
        "fileName": "luti2_advsimd.xml",
        "mask": 4292905984,
        "value": 1321205760,
        "bitCount": 14,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "op2",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "len",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 12,
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
            "FEAT_AdvSIMD && FEAT_LUT"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LUT",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "op2",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "op",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-fp8-luti"
    }
];
