export const ENCODINGS = [
    {
        "instructionId": "bfmul_z_zzi",
        "encodingId": "bfmul_z_zzi_h",
        "mnemonic": "BFMUL",
        "className": "SVE2",
        "fileName": "bfmul_z_zzi.xml",
        "mask": 4288740352,
        "value": 1679828992,
        "bitCount": 16,
        "fields": [
            {
                "name": "i3h",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "o2",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_B16B16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fmul-indexed"
    }
];
