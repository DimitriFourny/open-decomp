export const ENCODINGS = [
    {
        "instructionId": "smlal_za_zzv",
        "encodingId": "smlal_za_zzv_2x1",
        "mnemonic": "SMLAL",
        "className": "Two ZA double-vectors",
        "fileName": "smlal_za_zzv.xml",
        "mask": 4293958684,
        "value": 3244296192,
        "bitCount": 19,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 2,
                "width": 1
            },
            {
                "name": "off2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-long-arithmetic"
    },
    {
        "instructionId": "smlal_za_zzv",
        "encodingId": "smlal_za_zzv_4x1",
        "mnemonic": "SMLAL",
        "className": "Four ZA double-vectors",
        "fileName": "smlal_za_zzv.xml",
        "mask": 4293958684,
        "value": 3245344768,
        "bitCount": 19,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 2,
                "width": 1
            },
            {
                "name": "off2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-long-arithmetic"
    },
    {
        "instructionId": "smlal_za_zzv",
        "encodingId": "smlal_za_zzv_1",
        "mnemonic": "SMLAL",
        "className": "One ZA double-vector",
        "fileName": "smlal_za_zzv.xml",
        "mask": 4293958680,
        "value": 3244297216,
        "bitCount": 18,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-long-arithmetic"
    }
];
